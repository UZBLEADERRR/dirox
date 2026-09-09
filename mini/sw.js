/**
 * Offline shell + the trick that gives every mini-app a real home-screen icon.
 *
 * Chrome will not install a web app from a `data:` manifest, and this project
 * has no server to generate one per app. So the page writes a manifest and its
 * icons into the `mini-dynamic` cache under same-origin URLs (`m/<id>.webmanifest`,
 * `i/<id>-192.png`) and this worker serves them back as if a server had.
 */

const VERSION = 'mini-v8';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/main.js', './js/store.js', './js/i18n.js', './js/llm.js', './js/agent.js',
  './js/tools.js', './js/sandbox.js', './js/md.js', './js/icons.js', './js/market.js',
  './js/auth.js', './js/templates.js', './js/extract.js', './js/subagent.js',
  './js/zip.js', './js/github.js',
  './js/ui/dom.js', './js/ui/chat.js', './js/ui/drawer.js', './js/ui/sheets.js',
  './js/ui/apps.js', './js/ui/market.js', './js/ui/auth.js', './js/ui/admin.js',
  './assets/mark.png', './assets/icon-180.png', './assets/icon-192.png', './assets/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== VERSION && k !== 'mini-dynamic') await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

/** index.html, re-pointed at one app. */
async function appShell(id) {
  const res = (await caches.match('./index.html')) || await fetch('./index.html').catch(() => null);
  if (!res) return new Response('offline', { status: 503 });
  const html = (await res.text())
    .replace(/<head([^>]*)>/i, `<head$1><base href="../../">`)
    .replace(/<link rel="manifest"[^>]*>/i,
             `<link rel="manifest" href="m/${id}.webmanifest" id="manifest-link">`)
    .replace(/<link rel="apple-touch-icon"[^>]*>/i,
             `<link rel="apple-touch-icon" href="i/${id}-192.png" id="apple-icon">`);
  return new Response(html, { headers:{ 'Content-Type':'text/html; charset=utf-8',
                                        'Cache-Control':'no-cache' } });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // model traffic goes straight out
  if (url.pathname.startsWith('/api/')) return;        // the market answers for itself

  // Per-app manifests and icons, written by the page.
  if (/\/(m|i)\//.test(url.pathname)) {
    e.respondWith(caches.open('mini-dynamic')
      .then(c => c.match(req))
      .then(r => r || fetch(req).catch(() => new Response('', { status:404 }))));
    return;
  }

  // A mini app's own address. The shell is the same document, served with a
  // <base> so its relative URLs still resolve, and with the manifest and icon
  // pointing at this app — which is what makes the browser install *it*.
  const app = url.pathname.match(/\/a\/([A-Za-z0-9_-]{2,64})\/?$/);
  if (req.mode === 'navigate' && app) {
    e.respondWith(appShell(app[1]));
    return;
  }

  // Every other navigation resolves to the shell; routing happens in the page.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match('./index.html')) || Response.error(); }
    })());
    return;
  }

  // Everything else: cache first, refresh in the background.
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch:false });
    const net = fetch(req).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || net;
  })());
});
