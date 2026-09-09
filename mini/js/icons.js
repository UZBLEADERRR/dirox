/**
 * Icons are drawn, not shipped: a rounded square in the app's colour with its
 * emoji centred. That keeps the whole thing to a handful of static files and
 * lets every mini-app the user invents have a real home-screen icon.
 */

export const PALETTE = ['#E8171F','#0A0A0B','#F0A93B','#31C56B','#3B82F6','#8B5CF6','#EC4899','#0EA5A5'];

export const EMOJIS = ('🧮 📝 ⏱ 📷 🎨 🎵 💪 💧 📚 🍳 💰 ✅ 🎯 🌤 🗓 🔦 🎲 🧠 🏃 🛒 ' +
  '📊 🔐 🌱 ⭐ 🔔 🧩 🚗 ✈️ 🐱 🍎 ☕ 🎮 📌 🔬 🧭 🪙 🕹 🎁 🩺 🧺').split(' ');

/** Rounded-square PNG with a centred glyph, or the app's own picture. */
export function iconDataUrl(emoji, color, size = 192, image = null) {
  if (image) return image;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size * 0.23;

  g.fillStyle = color || '#7c8cff';
  g.beginPath();
  if (g.roundRect) g.roundRect(0, 0, size, size, r);
  else g.rect(0, 0, size, size);
  g.fill();

  g.font = `${Math.round(size * 0.55)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji || '📱', size / 2, size * 0.54);
  return c.toDataURL('image/png');
}

async function dataUrlToBlob(url) { return await (await fetch(url)).blob(); }

/** Where the app lives. `<base>` makes this right on a per-app page too. */
export const appRoot = () => new URL(document.baseURI).pathname.replace(/[^/]*$/, '');

/**
 * Every mini app gets its own URL, and that is the whole trick.
 *
 * Swapping the manifest on one page does not work: the browser has already
 * decided what this page is, and "add to home screen" adds that — which is why
 * it kept adding Mini itself. A separate path gives the app its own scope, its
 * own start_url and its own manifest id, so the browser treats it as a
 * different application rather than another copy of this one.
 */
export const appUrl = (id) => `${appRoot()}a/${id}/`;

/**
 * Gives one mini-app a real, installable identity.
 *
 * Chrome will not install from a `data:` manifest, and this app has no server
 * to generate one — so the manifest and its icons are written into the Cache
 * Storage under same-origin URLs and the service worker serves them back.
 * iOS ignores manifests for Add-to-Home-Screen and reads the apple-touch-icon
 * and title from the live document, so those are swapped in too.
 */
export async function applyAppIdentity(app) {
  const base = appRoot();
  const home = appUrl(app.id);
  const icon192 = iconDataUrl(app.emoji, app.color, 192, app.iconImage);
  const icon512 = iconDataUrl(app.emoji, app.color, 512, app.iconImage);

  document.title = app.name;
  set('meta[name="apple-mobile-web-app-title"]', 'content', app.name);
  set('meta[name="theme-color"]', 'content', app.color || '#0b0b0c');
  set('#apple-icon', 'href', icon192);

  try {
    const cache = await caches.open('mini-dynamic');
    const u192 = `${base}i/${app.id}-192.png`;
    const u512 = `${base}i/${app.id}-512.png`;
    const uman = `${base}m/${app.id}.webmanifest`;

    await cache.put(u192, new Response(await dataUrlToBlob(icon192), { headers:{ 'Content-Type':'image/png' } }));
    await cache.put(u512, new Response(await dataUrlToBlob(icon512), { headers:{ 'Content-Type':'image/png' } }));
    await cache.put(uman, new Response(JSON.stringify({
      // Its own id, start_url and scope: three separate reasons for the
      // browser to treat this as its own application.
      id: home,
      name: app.name, short_name: app.name.slice(0, 12),
      start_url: home, scope: home,
      display: 'standalone', orientation: 'portrait',
      background_color: app.color || '#ffffff', theme_color: app.color || '#0b0b0c',
      icons: [
        { src:u192, sizes:'192x192', type:'image/png', purpose:'any' },
        { src:u512, sizes:'512x512', type:'image/png', purpose:'any maskable' },
      ],
    }), { headers:{ 'Content-Type':'application/manifest+json' } }));

    set('#manifest-link', 'href', uman);
  } catch { /* no cache API — iOS still gets title + apple-touch-icon */ }
}

/** Puts the shell's own identity back after leaving a mini-app. */
export function restoreIdentity() {
  if (/\/a\/[^/]+\/$/.test(location.pathname)) return;   // this page IS an app
  const base = appRoot();
  document.title = 'Mini';
  set('meta[name="apple-mobile-web-app-title"]', 'content', 'Mini');
  set('meta[name="theme-color"]', 'content', getComputedStyle(document.body).backgroundColor || '#0b0b0c');
  set('#apple-icon', 'href', base + 'assets/icon-180.png');
  set('#manifest-link', 'href', base + 'manifest.webmanifest');
}

function set(sel, attr, val) { const el = document.querySelector(sel); if (el) el.setAttribute(attr, val); }
