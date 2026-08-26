/**
 * Static asset serving for the single-page client.
 *
 * The web client is plain ES modules with no build step, so files are served
 * directly with long-lived caching for assets and no caching for the shell.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
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

function safePath(pathname) {
  if (pathname.includes('\0')) return null;
  const requested = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(join(WEB_ROOT, requested));
  if (full !== WEB_ROOT && !full.startsWith(`${WEB_ROOT}${sep}`)) return null;
  return full;
}

/**
 * @returns {Promise<boolean>} true when the response has been written.
 */
export async function serveStatic(req, res, url, { fallback = false } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname = url.pathname;
  if (pathname === '/' || fallback) pathname = '/index.html';

  let full = safePath(pathname);
  if (!full) return false;

  let info = await stat(full).catch(() => null);
  if (info?.isDirectory()) {
    full = join(full, 'index.html');
    info = await stat(full).catch(() => null);
  }

  // Unknown client-side route: fall back to the app shell so deep links work.
  if (!info && !extname(pathname)) {
    full = join(WEB_ROOT, 'index.html');
    info = await stat(full).catch(() => null);
  }
  if (!info?.isFile()) return false;

  const ext = extname(full).toLowerCase();
  const etag = `"${createHash('sha1').update(`${info.size}-${info.mtimeMs}`).digest('hex').slice(0, 20)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return true;
  }

  const isShell = full.endsWith('index.html');
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', info.size);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', isShell ? 'no-cache' : 'public, max-age=3600, must-revalidate');

  if (req.method === 'HEAD') { res.end(); return true; }

  await new Promise((done, fail) => {
    const stream = createReadStream(full);
    stream.on('error', fail);
    stream.on('end', done);
    stream.pipe(res);
  }).catch(() => { if (!res.writableEnded) res.end(); });

  return true;
}

export { WEB_ROOT };
