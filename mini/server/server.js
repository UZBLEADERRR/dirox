/**
 * Mini's market — a deliberately small server.
 *
 * The client is static and does all the thinking; this process only stores
 * what people publish and hands it back. Every read is a cacheable, immutable
 * file: the catalogue is one JSON blob rebuilt on write and served from memory
 * with an ETag, and each app bundle is addressed by a content hash so it can
 * be cached forever. Put a CDN in front and the origin sees almost nothing.
 *
 * Writes are the only expensive path, and they are rate limited to one
 * publish per person per day.
 *
 *   node server/server.js            # serves the app and the market on :8080
 *
 * Environment
 *   PORT               listen port (8080)
 *   MINI_DATA          data directory (mini/data)
 *   MINI_ADMIN_TOKEN   enables /api/admin/* when set
 *   MINI_MODERATE      "1" holds submissions for admin approval
 *   MINI_MAX_PER_DAY   publishes per device per day (1)
 *   MINI_MAX_PER_IP    publishes per address per day (20) — carrier NAT backstop
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.MINI_DATA || path.join(ROOT, 'data'));
const APPS = path.join(DATA, 'apps');
const PORT = Number(process.env.PORT || 8080);
const ADMIN = process.env.MINI_ADMIN_TOKEN || '';
const MODERATE = process.env.MINI_MODERATE === '1';
const PER_DAY = Number(process.env.MINI_MAX_PER_DAY || 1);
// Mobile carriers put whole cities behind one address, so the IP cap is only
// an anti-flood backstop — the device id is what enforces "one a day".
const PER_IP = Number(process.env.MINI_MAX_PER_IP || Math.max(20, PER_DAY * 20));

const LIMITS = {
  bundle: 400 * 1024,      // total size of one app
  files: 20,
  assets: 8,
  asset: 220 * 1024,
  name: 28,
  summary: 200,
  body: 1.5 * 1024 * 1024, // request body ceiling
};

/* ------------------------------------------------------------- storage */

for (const dir of [DATA, APPS]) fs.mkdirSync(dir, { recursive: true });

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);                // atomic: readers never see a half file
};

const state = {
  apps: readJson(path.join(DATA, 'apps.json'), []),        // catalogue rows
  limits: readJson(path.join(DATA, 'limits.json'), {}),    // device/ip -> day count
  installs: readJson(path.join(DATA, 'installs.json'), {}),
};

let catalogue = null;        // { json, gzip, etag }
let installsDirty = false, rebuildTimer = null;

function rebuild() {
  const live = state.apps.filter(a => a.status === 'live');
  const cats = new Map();
  for (const a of live) {
    const c = cats.get(a.cat) || { id: a.cat, name: a.catName || a.cat, icon: a.catIcon || '📦', count: 0 };
    c.count++;
    cats.set(a.cat, c);
  }
  const body = {
    updated: Date.now(),
    categories: [...cats.values()].sort((x, y) => y.count - x.count),
    apps: live
      .map(a => ({ id:a.id, name:a.name, emoji:a.emoji, color:a.color, cat:a.cat, catName:a.catName,
                   summary:a.summary, author:a.author, tags:a.tags, size:a.size, v:a.v,
                   installs:(state.installs[a.id] || 0) + (a.installs || 0), createdAt:a.createdAt }))
      .sort((x, y) => y.installs - x.installs || y.createdAt - x.createdAt),
  };
  const json = Buffer.from(JSON.stringify(body));
  catalogue = { json, gzip: zlib.gzipSync(json, { level: 6 }),
                etag: '"' + crypto.createHash('sha1').update(json).digest('hex').slice(0, 16) + '"' };
}

function persist() {
  writeJson(path.join(DATA, 'apps.json'), state.apps);
  rebuild();
}
rebuild();

/**
 * Install counts are noise until they are not.
 *
 * The catalogue is refreshed a few seconds after a burst of installs — long
 * enough to coalesce, short enough that a number never looks stuck — while the
 * disk write waits for the slower timer. Rebuilding stringifies and gzips the
 * whole catalogue, which is nothing at this size and would want a real
 * database long before it became something.
 */
function noteInstall(id) {
  state.installs[id] = (state.installs[id] || 0) + 1;
  installsDirty = true;
  if (!rebuildTimer) {
    rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(); }, 3000);
    rebuildTimer.unref?.();
  }
}
setInterval(() => {
  if (!installsDirty) return;
  installsDirty = false;
  writeJson(path.join(DATA, 'installs.json'), state.installs);
}, 30_000).unref();

/* --------------------------------------------------------------- utils */

const today = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 24) || 'boshqa';

const send = (res, code, body, headers = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
};
const json = (res, code, obj, headers = {}) =>
  send(res, code, obj, { 'Content-Type': 'application/json; charset=utf-8', ...headers });

const CORS = {
  'Access-Control-Allow-Origin': process.env.MINI_CORS || '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Mini-Device, X-Admin-Token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim()
    || req.socket.remoteAddress || '0.0.0.0';
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > LIMITS.body) throw new Error('too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/* ------------------------------------------------------------ validate */

/**
 * What a market app is allowed to be.
 *
 * Self-contained is the rule that matters: no external scripts, no remote
 * anything. It keeps installs offline-capable, keeps a published app from
 * changing under its users after review, and removes the whole class of
 * "harmless at review, hostile next Tuesday" attacks.
 */
function validate(p) {
  const bad = m => ({ error: m });
  if (!p || typeof p !== 'object') return bad('bo\'sh so\'rov');

  const name = String(p.name || '').trim();
  if (name.length < 2 || name.length > LIMITS.name) return bad('nom 2–28 belgi bo\'lsin');
  if (!p.files || typeof p.files !== 'object') return bad('fayllar yo\'q');

  const files = Object.entries(p.files).filter(([, v]) => typeof v === 'string');
  if (!files.length || files.length > LIMITS.files) return bad('fayllar soni noto\'g\'ri');
  if (!p.files['index.html']) return bad('index.html kerak');
  for (const [k] of files) {
    if (!/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/.test(k) || k.includes('..'))
      return bad('fayl nomi noto\'g\'ri: ' + k);
  }

  const assets = Array.isArray(p.assets) ? p.assets : [];
  if (assets.length > LIMITS.assets) return bad('rasm juda ko\'p');
  for (const a of assets) {
    if (typeof a?.data !== 'string' || !a.data.startsWith('data:')) return bad('rasm formati noto\'g\'ri');
    if (a.data.length > LIMITS.asset) return bad('rasm juda katta');
  }

  const size = files.reduce((n, [, v]) => n + v.length, 0)
             + assets.reduce((n, a) => n + a.data.length, 0);
  if (size > LIMITS.bundle) return bad('ilova juda katta (max 400 KB)');

  const html = files.map(([, v]) => v).join('\n');
  if (/<script[^>]+src\s*=\s*["']?\s*(https?:)?\/\//i.test(html))
    return bad('tashqi skript ishlatilgan — ilova mustaqil bo\'lishi kerak');
  if (/<link[^>]+href\s*=\s*["']?\s*(https?:)?\/\//i.test(html))
    return bad('tashqi stil ishlatilgan — ilova mustaqil bo\'lishi kerak');
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(html) && /https?:\/\//.test(html))
    return bad('tashqi tarmoqqa murojaat bor — ilova mustaqil bo\'lishi kerak');
  if (p.files['index.html'].replace(/\s/g, '').length < 200)
    return bad('ilova juda bo\'sh');

  return { ok: true, size };
}

/* ------------------------------------------------------------- routing */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '', CORS);

  try {
    if (p === '/api/market/index.json') return marketIndex(req, res);
    if (p.startsWith('/api/market/app/')) return marketApp(req, res, p.slice(16).replace(/\.json$/, ''));
    if (p === '/api/market/submit' && req.method === 'POST') return submit(req, res);
    if (p.startsWith('/api/market/install/') && req.method === 'POST')
      return install(req, res, p.slice(20));
    if (p === '/api/market/quota') return quota(req, res);
    if (p.startsWith('/api/admin/')) return admin(req, res, p.slice(11), url);
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' }, CORS);
    return statik(req, res, p);
  } catch (e) {
    json(res, 500, { error: 'server error' }, CORS);
    console.error(e);
  }
});

/* ------------------------------------------------------------ handlers */

function marketIndex(req, res) {
  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'ETag': catalogue.etag,
    'Cache-Control': 'public, max-age=120, stale-while-revalidate=600',
  };
  if (req.headers['if-none-match'] === catalogue.etag) {
    res.writeHead(304, headers); return res.end();
  }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || ''))
    return send(res, 200, catalogue.gzip, { ...headers, 'Content-Encoding': 'gzip' });
  send(res, 200, catalogue.json, headers);
}

function marketApp(req, res, id) {
  if (!/^[a-zA-Z0-9_-]{4,40}$/.test(id)) return json(res, 400, { error: 'bad id' }, CORS);
  const row = state.apps.find(a => a.id === id && a.status === 'live');
  if (!row) return json(res, 404, { error: 'topilmadi' }, CORS);
  const file = path.join(APPS, id + '.json');
  if (!fs.existsSync(file)) return json(res, 404, { error: 'topilmadi' }, CORS);
  // The id carries the content hash, so this body can never change.
  res.writeHead(200, { ...CORS, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
}

function quotaKeyState(device, ip) {
  const day = today();
  const dev = state.limits[device] || {};
  const byIp = state.limits['ip:' + ip] || {};
  return { day, used: dev.day === day ? dev.n : 0, ipUsed: byIp.day === day ? byIp.n : 0 };
}

function quota(req, res) {
  const device = String(req.headers['x-mini-device'] || '').slice(0, 64);
  const { used } = quotaKeyState(device, clientIp(req));
  json(res, 200, { perDay: PER_DAY, used, left: Math.max(0, PER_DAY - used) },
       { ...CORS, 'Cache-Control': 'no-store' });
}

async function submit(req, res) {
  const device = String(req.headers['x-mini-device'] || '').slice(0, 64);
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(device))
    return json(res, 400, { error: 'qurilma aniqlanmadi' }, CORS);

  const ip = clientIp(req);
  const { day, used, ipUsed } = quotaKeyState(device, ip);
  if (used >= PER_DAY || ipUsed >= PER_IP)
    return json(res, 429, { error: `Kuniga ${PER_DAY} ta ilova joylash mumkin. Ertaga urinib ko'ring.` }, CORS);

  let payload;
  try { payload = await readBody(req); }
  catch { return json(res, 413, { error: 'so\'rov juda katta' }, CORS); }

  const v = validate(payload);
  if (v.error) return json(res, 400, { error: v.error }, CORS);

  const review = payload.review || {};
  if (review.ok !== true)
    return json(res, 400, { error: 'AI tekshiruvidan o\'tmagan' }, CORS);

  const bundle = {
    name: String(payload.name).trim().slice(0, LIMITS.name),
    emoji: String(payload.emoji || '📦').slice(0, 4),
    color: /^#[0-9a-f]{6}$/i.test(payload.color || '') ? payload.color : '#E8171F',
    files: payload.files,
    assets: Array.isArray(payload.assets) ? payload.assets : [],
    deviceAccess: false,                     // market apps never get same-origin
  };

  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(bundle.files) + JSON.stringify(bundle.assets)).digest('hex').slice(0, 10);
  const id = slug(bundle.name).slice(0, 18) + '-' + hash;

  if (state.apps.some(a => a.id === id))
    return json(res, 409, { error: 'bu ilova allaqachon joylangan' }, CORS);

  const row = {
    id,
    name: bundle.name,
    emoji: bundle.emoji,
    color: bundle.color,
    cat: slug(review.category || payload.cat),
    catName: String(review.categoryName || review.category || 'Boshqa').slice(0, 24),
    catIcon: String(review.categoryIcon || '📦').slice(0, 4),
    summary: String(review.summary || payload.summary || '').slice(0, LIMITS.summary),
    tags: (Array.isArray(review.tags) ? review.tags : []).slice(0, 5).map(t => String(t).slice(0, 18)),
    author: String(payload.author || 'anonim').slice(0, 24),
    size: v.size,
    v: hash,
    installs: 0,
    createdAt: Date.now(),
    status: MODERATE ? 'pending' : 'live',
    review: { model: String(review.model || '').slice(0, 60), score: Number(review.score) || 0,
              note: String(review.note || '').slice(0, 300) },
    ip,
    device,
  };

  await fsp.writeFile(path.join(APPS, id + '.json'), JSON.stringify({ ...row, ...bundle, ip:undefined, device:undefined }));
  state.apps.unshift(row);
  state.limits[device] = { day, n: used + 1 };
  state.limits['ip:' + ip] = { day, n: ipUsed + 1 };
  writeJson(path.join(DATA, 'limits.json'), state.limits);
  persist();

  json(res, 200, { ok: true, id, status: row.status }, CORS);
}

function install(req, res, id) {
  if (!/^[a-zA-Z0-9_-]{4,40}$/.test(id)) return json(res, 400, { error: 'bad id' }, CORS);
  noteInstall(id);
  send(res, 204, '', CORS);
}

function admin(req, res, action, url) {
  if (!ADMIN || req.headers['x-admin-token'] !== ADMIN)
    return json(res, 403, { error: 'forbidden' }, CORS);

  if (action === 'pending')
    return json(res, 200, state.apps.filter(a => a.status !== 'live'), CORS);
  if (action === 'all')
    return json(res, 200, state.apps, CORS);

  const id = url.searchParams.get('id');
  const row = state.apps.find(a => a.id === id);
  if (!row) return json(res, 404, { error: 'not found' }, CORS);

  if (action === 'publish') { row.status = 'live'; persist(); return json(res, 200, { ok: true }, CORS); }
  if (action === 'remove') {
    row.status = 'removed';
    fs.rmSync(path.join(APPS, id + '.json'), { force: true });
    persist();
    return json(res, 200, { ok: true }, CORS);
  }
  json(res, 404, { error: 'not found' }, CORS);
}

/* --------------------------------------------------------------- static */

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8',
};

function statik(req, res, p) {
  const rel = decodeURIComponent(p).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html'))
    return send(res, 403, 'forbidden');
  if (rel.startsWith('data/') || rel.startsWith('server/') || rel.startsWith('test/'))
    return send(res, 404, 'not found');

  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) {                     // SPA: unknown path -> shell
      return fs.createReadStream(path.join(ROOT, 'index.html'))
        .on('open', () => res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }))
        .pipe(res);
    }
    const ext = path.extname(file);
    const immutable = /^assets\//.test(rel);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': rel === 'sw.js' || rel === 'index.html'
        ? 'no-cache'
        : immutable ? 'public, max-age=604800' : 'public, max-age=3600',
      'Last-Modified': st.mtime.toUTCString(),
    });
    fs.createReadStream(file).pipe(res);
  });
}

server.listen(PORT, () => {
  console.log(`Mini ${PORT}-portda. Ma'lumot: ${DATA}` +
    (MODERATE ? ' | moderatsiya: yoqilgan' : '') + (ADMIN ? ' | admin: yoqilgan' : ''));
});

export { server, validate };
