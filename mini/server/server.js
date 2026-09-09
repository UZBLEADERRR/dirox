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
 *   MINI_INACTIVE_DAYS days of silence before an account is deleted (30)
 *   MINI_SECRET        session signing key (generated into MINI_DATA if unset)
 *   MINI_REGS_PER_HOUR sign-ups allowed per address per hour (10)
 *   MINI_FREE_BASE_URL, MINI_FREE_KEY, MINI_FREE_MODEL, MINI_FREE_LABEL,
 *   MINI_FREE_PER_DAY  a model the operator pays for, offered to signed-in
 *                      users who have not brought a key of their own. Can also
 *                      be set at runtime through /api/admin/config.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './store.js';
import { Auth } from './auth.js';

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
const INACTIVE_DAYS = Number(process.env.MINI_INACTIVE_DAYS || 30);

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

const auth = new Auth(DATA, { inactiveDays: INACTIVE_DAYS, secret: process.env.MINI_SECRET });

/**
 * The operator's own model, billed to them.
 *
 * Someone arriving with no API key has nothing to try the product with, so an
 * operator can put one model behind the server and cap how much of it each
 * person gets in a day. The key never leaves this process: the client posts to
 * /api/ai/chat and the upstream response is piped straight back.
 */
const freeFile = path.join(DATA, 'config.json');
let free = readJson(freeFile, null) || (process.env.MINI_FREE_KEY ? {
  baseUrl: process.env.MINI_FREE_BASE_URL || 'https://openrouter.ai/api/v1',
  key: process.env.MINI_FREE_KEY,
  model: process.env.MINI_FREE_MODEL || '',
  label: process.env.MINI_FREE_LABEL || 'Free model',
  perDay: Number(process.env.MINI_FREE_PER_DAY || 30),
} : null);

const freePublic = () => (free?.key && free.model
  ? { model: free.model, label: free.label || 'Free model', perDay: free.perDay || 30 }
  : null);

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
                   summary:a.summary, author:a.author, authorUsername:a.authorUsername,
                   type:a.type || 'app', iconImage:a.iconImage || null,
                   line:a.line || a.id, version:a.version || 1,
                   tags:a.tags, size:a.size, v:a.v, updatedAt:a.updatedAt || a.createdAt,
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Mini-Device, X-Admin-Token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim()
    || req.socket.remoteAddress || '0.0.0.0';
}

const bearer = req => auth.verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

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
  if (!p || typeof p !== 'object') return bad('empty request');

  const name = String(p.name || '').trim();
  if (name.length < 2 || name.length > LIMITS.name) return bad('the name must be 2-28 characters');
  if (!p.files || typeof p.files !== 'object') return bad('no files');

  const files = Object.entries(p.files).filter(([, v]) => typeof v === 'string');
  if (!files.length || files.length > LIMITS.files) return bad('wrong number of files');
  if (!p.files['index.html']) return bad('index.html is required');
  for (const [k] of files) {
    if (!/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/.test(k) || k.includes('..'))
      return bad('bad file name: ' + k);
  }

  const assets = Array.isArray(p.assets) ? p.assets : [];
  if (assets.length > LIMITS.assets) return bad('too many images');
  for (const a of assets) {
    if (typeof a?.data !== 'string' || !a.data.startsWith('data:')) return bad('unsupported image format');
    if (a.data.length > LIMITS.asset) return bad('image too large');
  }

  const size = files.reduce((n, [, v]) => n + v.length, 0)
             + assets.reduce((n, a) => n + a.data.length, 0);
  if (size > LIMITS.bundle) return bad('too large (400 KB maximum)');

  const html = files.map(([, v]) => v).join('\n');
  if (/<script[^>]+src\s*=\s*["']?\s*(https?:)?\/\//i.test(html))
    return bad('external script used — an app must be self-contained');
  if (/<link[^>]+href\s*=\s*["']?\s*(https?:)?\/\//i.test(html))
    return bad('external stylesheet used — an app must be self-contained');
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(html) && /https?:\/\//.test(html))
    return bad('it calls out to the network — an app must be self-contained');
  if (p.files['index.html'].replace(/\s/g, '').length < 200)
    return bad('there is almost nothing in it');

  return { ok: true, size };
}

/* ------------------------------------------------------------- routing */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '', CORS);

  try {
    if (p === '/api/health') return json(res, 200, {
      ok: true, apps: state.apps.filter(a => a.status === 'live').length,
      moderate: MODERATE, free: !!freePublic(), uptime: Math.round(process.uptime()),
    }, { ...CORS, 'Cache-Control': 'no-store' });
    if (p === '/api/config') return json(res, 200, { free: freePublic() },
      { ...CORS, 'Cache-Control': 'public, max-age=60' });
    if (p === '/api/ai/chat' && req.method === 'POST') return relay(req, res);
    if (p.startsWith('/api/auth/')) return authRoute(req, res, p.slice(10));
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

/* ---------------------------------------------------------------- auth */

async function authRoute(req, res, action) {
  const ip = clientIp(req);

  if (action === 'register' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const r = auth.register({ ...body, ip });
    if (r.error) return json(res, 400, { error: r.error }, CORS);
    return json(res, 200, { token: auth.issue(r.user), user: auth.publicUser(r.user) },
                { ...CORS, 'Cache-Control': 'no-store' });
  }

  if (action === 'login' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const r = auth.login({ ...body, ip });
    if (r.error) return json(res, 401, { error: r.error }, CORS);
    return json(res, 200, { token: auth.issue(r.user), user: auth.publicUser(r.user) },
                { ...CORS, 'Cache-Control': 'no-store' });
  }

  const user = bearer(req);
  if (!user) return json(res, 401, { error: 'sign in required' }, { ...CORS, 'Cache-Control': 'no-store' });

  if (action === 'me' && req.method === 'GET') {
    const { used } = quotaState(user);
    const day = today();
    const aiUsed = user.aiDay === day ? (user.aiCount || 0) : 0;
    return json(res, 200, {
      user: auth.publicUser(user),
      quota: { perDay: PER_DAY, used, left: Math.max(0, PER_DAY - used) },
      free: freePublic() && { ...freePublic(), used: aiUsed,
                              left: Math.max(0, (freePublic().perDay) - aiUsed) },
    }, { ...CORS, 'Cache-Control': 'no-store' });
  }

  if (action === 'password' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const r = auth.changePassword(user, body);
    if (r.error) return json(res, 400, { error: r.error }, CORS);
    return json(res, 200, { token: auth.issue(user) }, { ...CORS, 'Cache-Control': 'no-store' });
  }

  if (action === 'me' && req.method === 'DELETE') {
    auth.remove(user.id);
    return json(res, 200, { ok: true }, CORS);
  }

  json(res, 404, { error: 'not found' }, CORS);
}

/* ---------------------------------------------------------------- relay */

const FREE_DAY = () => today();

async function relay(req, res) {
  const user = bearer(req);
  if (!user) return json(res, 401, { error: 'sign in required' }, CORS);
  if (!free?.key || !free.model)
    return json(res, 503, { error: 'No free model is configured on this server.' }, CORS);

  const day = FREE_DAY();
  const used = user.aiDay === day ? (user.aiCount || 0) : 0;
  const cap = free.perDay || 30;
  if (used >= cap)
    return json(res, 429, { error: `Free model: ${cap} messages a day. Add your own API key for more.` }, CORS);

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 413, { error: 'request too large' }, CORS); }
  if (!Array.isArray(body.messages) || !body.messages.length)
    return json(res, 400, { error: 'no messages' }, CORS);

  user.aiDay = day;
  user.aiCount = used + 1;
  auth.flush();

  const upstream = await fetch(free.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${free.key}`,
      ...(/openrouter/i.test(free.baseUrl) ? { 'HTTP-Referer': 'https://mini.app', 'X-Title': 'Mini' } : {}),
    },
    // The model is ours to choose; everything else is the caller's.
    body: JSON.stringify({ ...body, model: free.model, stream: true }),
  }).catch(e => ({ ok:false, status:502, text: async () => e.message }));

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return json(res, 502, { error: 'The free model is unavailable right now.',
                            detail: String(detail).slice(0, 200) }, CORS);
  }

  res.writeHead(200, { ...CORS, 'Content-Type':'text/event-stream',
                       'Cache-Control':'no-cache', 'X-Mini-Free-Left': String(cap - used - 1) });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(r => res.once('drain', r));
    }
  } catch { /* the client hung up */ }
  res.end();
}

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
  if (!row) return json(res, 404, { error: 'not found' }, CORS);
  const file = path.join(APPS, id + '.json');
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' }, CORS);
  // The id carries the content hash, so this body can never change.
  res.writeHead(200, { ...CORS, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
}

/** Is this a new version of something this person already has in the market? */
function isUpdateOf(user, payload) {
  const line = slug(user.username + '-' + String(payload?.name || '').trim().slice(0, LIMITS.name));
  return state.apps.some(a => a.line === line && a.status === 'live');
}

/** One publish a day, counted against the account rather than the browser. */
function quotaState(user) {
  const day = today();
  return { day, used: user.publishDay === day ? (user.publishCount || 0) : 0 };
}

function ipState(ip) {
  const day = today();
  const byIp = state.limits['ip:' + ip] || {};
  return { day, ipUsed: byIp.day === day ? byIp.n : 0 };
}

function quota(req, res) {
  const user = bearer(req);
  if (!user) return json(res, 401, { error: 'sign in required' }, { ...CORS, 'Cache-Control': 'no-store' });
  const { used } = quotaState(user);
  json(res, 200, { perDay: PER_DAY, used, left: Math.max(0, PER_DAY - used) },
       { ...CORS, 'Cache-Control': 'no-store' });
}

async function submit(req, res) {
  const user = bearer(req);
  if (!user) return json(res, 401, { error: 'Sign in to publish' }, CORS);

  const ip = clientIp(req);
  const { day, used } = quotaState(user);
  const { ipUsed } = ipState(ip);
  if (ipUsed >= PER_IP)
    return json(res, 429, { error: 'Too many publishes from this network today.' }, CORS);

  let payload;
  try { payload = await readBody(req); }
  catch { return json(res, 413, { error: 'request too large' }, CORS); }

  // The daily limit is about new apps. Publishing a fix to something already
  // in the market is charged at a third of one, so a bug does not have to
  // wait until tomorrow.
  if (used >= PER_DAY && !isUpdateOf(user, payload))
    return json(res, 429, { error: `${PER_DAY} app per day. Try again tomorrow.` }, CORS);

  const v = validate(payload);
  if (v.error) return json(res, 400, { error: v.error }, CORS);

  const review = payload.review || {};
  if (review.ok !== true)
    return json(res, 400, { error: 'did not pass AI review' }, CORS);

  const bundle = {
    name: String(payload.name).trim().slice(0, LIMITS.name),
    emoji: String(payload.emoji || '📦').slice(0, 4),
    color: /^#[0-9a-f]{6}$/i.test(payload.color || '') ? payload.color : '#E8171F',
    iconImage: typeof payload.iconImage === 'string' && payload.iconImage.startsWith('data:image/')
      && payload.iconImage.length < 120_000 ? payload.iconImage : null,
    files: payload.files,
    assets: Array.isArray(payload.assets) ? payload.assets : [],
    deviceAccess: false,                     // market apps never get same-origin
  };

  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(bundle.files) + JSON.stringify(bundle.assets)).digest('hex').slice(0, 10);
  const id = slug(bundle.name).slice(0, 18) + '-' + hash;

  if (state.apps.some(a => a.id === id))
    return json(res, 409, { error: 'this app is already published' }, CORS);

  // Same person, same name: a new version of something they already published.
  // Updating should not cost the one new app they get in a day — a bug fix a
  // user is waiting for is not a new submission — but it is still capped.
  const line = slug(user.username + '-' + bundle.name);
  const previous = state.apps.find(a => a.line === line && a.status === 'live');
  const isUpdate = !!previous;
  if (isUpdate && used >= PER_DAY + 1)
    return json(res, 429, { error: 'Too many updates today. Try again tomorrow.' }, CORS);

  const row = {
    id,
    name: bundle.name,
    emoji: bundle.emoji,
    color: bundle.color,
    type: ['app', 'course', 'book'].includes(payload.type) ? payload.type : 'app',
    line,
    version: (previous?.version || 0) + 1,
    cat: slug(review.category || payload.cat),
    catName: String(review.categoryName || review.category || 'Boshqa').slice(0, 24),
    catIcon: String(review.categoryIcon || '📦').slice(0, 4),
    summary: String(review.summary || payload.summary || '').slice(0, LIMITS.summary),
    tags: (Array.isArray(review.tags) ? review.tags : []).slice(0, 5).map(t => String(t).slice(0, 18)),
    author: user.name,
    authorId: user.id,
    authorUsername: user.username,
    size: v.size,
    v: hash,
    installs: previous?.installs || 0,
    createdAt: previous?.createdAt || Date.now(),
    updatedAt: Date.now(),
    status: MODERATE ? 'pending' : 'live',
    review: { model: String(review.model || '').slice(0, 60), score: Number(review.score) || 0,
              note: String(review.note || '').slice(0, 300) },
    ip,
  };

  row.iconImage = bundle.iconImage;
  await fsp.writeFile(path.join(APPS, id + '.json'),
    JSON.stringify({ ...row, ...bundle, ip: undefined, authorId: undefined }));
  if (previous) {
    previous.status = 'replaced';
    state.installs[id] = state.installs[previous.id] || 0;   // carry the count over
  }
  state.apps.unshift(row);
  user.publishDay = day;
  // An update is charged at a lower rate than a new app.
  user.publishCount = used + (isUpdate ? 0.34 : 1);
  user.apps = (user.apps || 0) + 1;
  auth.flush();
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

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function admin(req, res, action, url) {
  if (!ADMIN || !sameToken(req.headers['x-admin-token'], ADMIN))
    return json(res, 403, { error: 'forbidden' }, CORS);

  if (action === 'pending')
    return json(res, 200, state.apps.filter(a => a.status !== 'live'), CORS);
  if (action === 'all')
    return json(res, 200, state.apps, CORS);
  if (action === 'users')
    return json(res, 200, auth.users.map(u => auth.publicUser(u)), CORS);
  if (action === 'sweep')
    return json(res, 200, { removed: auth.sweep() }, CORS);
  if (action === 'config') {
    if (req.method !== 'POST') return json(res, 200, { free: freePublic() }, CORS);
    return readBody(req).then(body => {
      if (body.clear) { free = null; fs.rmSync(freeFile, { force:true }); }
      else {
        free = {
          baseUrl: String(body.baseUrl || 'https://openrouter.ai/api/v1'),
          key: String(body.key || free?.key || ''),
          model: String(body.model || ''),
          label: String(body.label || 'Free model').slice(0, 40),
          perDay: Math.max(1, Math.min(500, Number(body.perDay) || 30)),
        };
        writeJson(freeFile, free);
      }
      json(res, 200, { free: freePublic() }, CORS);
    }).catch(() => json(res, 400, { error: 'bad request' }, CORS));
  }

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

/**
 * A mini app's own address, served before a service worker exists.
 *
 * Same document, with a <base> so its relative URLs still resolve and with the
 * manifest and icon pointing at this app — so the browser installs the app the
 * person is looking at rather than Mini itself.
 */
function appShell(res, id) {
  fs.readFile(path.join(ROOT, 'index.html'), 'utf8', (err, html) => {
    if (err) return send(res, 500, 'no shell');
    const out = html
      .replace(/<head([^>]*)>/i, '<head$1><base href="../../">')
      .replace(/<link rel="manifest"[^>]*>/i,
               `<link rel="manifest" href="m/${id}.webmanifest" id="manifest-link">`)
      .replace(/<link rel="apple-touch-icon"[^>]*>/i,
               `<link rel="apple-touch-icon" href="i/${id}-192.png" id="apple-icon">`);
    send(res, 200, out, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
  });
}

function statik(req, res, p) {
  const app = p.match(/^\/a\/([A-Za-z0-9_-]{2,64})\/?$/);
  if (app) return appShell(res, app[1]);

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

/**
 * Accounts nobody has opened in a month are removed, checked hourly so a
 * restarted process still gets to it. Published apps outlive their author.
 */
setInterval(() => {
  const gone = auth.sweep();
  if (gone.length) console.log(`${gone.length} inactive accounts removed`);

  // Yesterday's per-address counters are dead weight; drop them.
  const day = today();
  let dropped = 0;
  for (const k of Object.keys(state.limits)) {
    if (state.limits[k]?.day !== day) { delete state.limits[k]; dropped++; }
  }
  if (dropped) writeJson(path.join(DATA, 'limits.json'), state.limits);
}, 3600_000).unref();
setTimeout(() => auth.sweep(), 10_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mini on :${PORT} | data ${DATA} | ${auth.users.length} accounts` +
    (MODERATE ? ' | moderation on' : '') + (ADMIN ? ' | admin on' : '') +
    (freePublic() ? ` | free model ${free.model}` : ''));
});

/**
 * A deploy is a SIGTERM away, and install counts live in memory between
 * flushes. Write them out and stop taking new connections before going.
 */
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (closing) process.exit(0);
    closing = true;
    if (installsDirty) writeJson(path.join(DATA, 'installs.json'), state.installs);
    auth.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export { server, validate };
