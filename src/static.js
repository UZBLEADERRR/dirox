/**
 * Static asset serving for the single-page client.
 *
 * The client is plain ES modules with no build step, which leaves one hard
 * problem: every file keeps its URL forever, so a browser holding yesterday's
 * `main.js` and today's `styles.css` renders a half-broken interface and has no
 * way to know. Revalidating everything avoids the stale copy but not the mixed
 * one — a deploy landing between two requests still splits a page across two
 * versions.
 *
 * So the shell is rewritten on the way out. Asset URLs inside `index.html` are
 * prefixed with the current build — `/app/main.js` becomes
 * `/v/9f21c3.../app/main.js` — and the prefix is stripped again on the way in.
 * Relative imports inherit the prefix for free, because a module at
 * `/v/9f21c3/app/main.js` resolves `./lib/api.js` against its own directory. A
 * page therefore loads every file from one build or none.
 *
 * That makes versioned URLs genuinely immutable, so they cache for a year. The
 * shell itself never caches, which is what makes a deploy visible on the next
 * navigation rather than an hour later.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const WEB_ROOT = resolve(fileURLToPath(new URL('../web', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/** `/v/<build>/rest` — the versioned form of any asset path. */
const VERSIONED = /^\/v\/([A-Za-z0-9]{6,40})\//;

/** Directories whose URLs are stamped with the build id inside the shell. */
const VERSIONED_ROOTS = ['/app/', '/styles/', '/assets/'];

const YEAR = 31_536_000;

let buildPromise = null;
let shellCache = null;

/**
 * An identifier for the client currently on disk.
 *
 * Hashed from the files' contents rather than a commit, so it is right even
 * when the deploy carries no git metadata — and rather than their timestamps,
 * so a deploy that only touched the server leaves every stamped URL alone and
 * the browser keeps the copy it already has. It changes when, and only when,
 * the client changes.
 */
export function buildId() {
  buildPromise ??= (async () => {
    const hash = createHash('sha1');
    const walk = async dir => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        const content = await readFile(full).catch(() => null);
        if (content) hash.update(`${relative(WEB_ROOT, full)}:`).update(content).update('\n');
      }
    };
    await walk(WEB_ROOT);
    return hash.digest('hex').slice(0, 12);
  })().catch(() => String(Date.now()));

  return buildPromise;
}

function safePath(pathname) {
  if (pathname.includes('\0')) return null;
  const requested = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(join(WEB_ROOT, requested));
  if (full !== WEB_ROOT && !full.startsWith(`${WEB_ROOT}${sep}`)) return null;
  return full;
}

/**
 * The shell, with its asset URLs stamped.
 *
 * Only absolute URLs into the client's own directories are touched, so a link
 * to a route, an external URL or the manifest is left exactly as written.
 */
async function versionedShell(full, build) {
  if (shellCache?.build === build) return shellCache.body;

  const source = await readFile(full, 'utf8');
  const body = source.replace(/(\s(?:src|href)=")(\/[^"]*)"/g, (match, attribute, url) =>
    VERSIONED_ROOTS.some(root => url.startsWith(root))
      ? `${attribute}/v/${build}${url}"`
      : match);

  shellCache = { build, body: Buffer.from(body) };
  return shellCache.body;
}

/**
 * @returns {Promise<boolean>} true when the response has been written.
 */
export async function serveStatic(req, res, url, { fallback = false } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname = url.pathname;

  // A versioned request is the same file; the prefix exists only to give the
  // URL a new identity when the build changes.
  const stamped = VERSIONED.exec(pathname);
  if (stamped) pathname = pathname.slice(stamped[0].length - 1);

  if (pathname === '/' || fallback) pathname = '/index.html';

  let full = safePath(pathname);
  if (!full) return false;

  let info = await stat(full).catch(() => null);
  if (info?.isDirectory()) {
    full = join(full, 'index.html');
    info = await stat(full).catch(() => null);
  }

  // Unknown client-side route: fall back to the app shell so deep links work.
  // A missing asset must still 404 — handing a module HTML instead of
  // JavaScript turns a typo into a baffling syntax error.
  if (!info && !extname(pathname) && !stamped) {
    full = join(WEB_ROOT, 'index.html');
    info = await stat(full).catch(() => null);
  }
  if (!info?.isFile()) return false;

  const isShell = full === join(WEB_ROOT, 'index.html');
  const build = await buildId();
  const ext = extname(full).toLowerCase();

  const body = isShell ? await versionedShell(full, build) : null;
  const etag = `"${createHash('sha1')
    .update(isShell ? `shell-${build}` : `${info.size}-${info.mtimeMs}`)
    .digest('hex').slice(0, 20)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return true;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', body ? body.length : info.size);
  res.setHeader('ETag', etag);

  // A stamped URL names one build and can never mean anything else, so it is
  // safe to keep for a year. Everything else — the shell above all — is
  // revalidated, because that is what makes a deploy visible immediately.
  res.setHeader('Cache-Control', stamped && !isShell
    ? `public, max-age=${YEAR}, immutable`
    : 'no-cache, must-revalidate');

  if (req.method === 'HEAD') { res.end(); return true; }
  if (body) { res.end(body); return true; }

  await new Promise((done, fail) => {
    const stream = createReadStream(full);
    stream.on('error', fail);
    stream.on('end', done);
    stream.pipe(res);
  }).catch(() => { if (!res.writableEnded) res.end(); });

  return true;
}

export { WEB_ROOT };
