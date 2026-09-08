/**
 * Regenerates mini/assets/* from assets/brand/logo-source.png.
 *
 * The source is a red mark on a white square. There is no image library in
 * this project, so the work happens in a real canvas: knock out the white
 * ground, trim to the mark, then compose it at each size the manifest and iOS
 * ask for. Run after changing the logo.
 *
 *   node scripts/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');
const SRC = path.join(ASSETS, 'brand', 'logo-source.png');
const INK = '#0A0A0B';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright kerak: npm i -D playwright'); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

const out = await page.evaluate(async ({ src, ink }) => {
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });

  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const o = (y * c.width + x) * 4;
    const light = Math.min(p[o], p[o + 1], p[o + 2]);
    if (light > 244) { p[o + 3] = 0; continue; }
    if (light > 215) p[o + 3] = Math.round((244 - light) / 29 * 255);
    if (p[o + 3] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  g.putImageData(d, 0, 0);

  const w = maxX - minX + 1, h = maxY - minY + 1;
  const mark = document.createElement('canvas');
  mark.width = w; mark.height = h;
  mark.getContext('2d').drawImage(c, minX, minY, w, h, 0, 0, w, h);

  const make = (cw, ch, bg, scale, radius) => {
    const o = document.createElement('canvas');
    o.width = cw; o.height = ch;
    const x = o.getContext('2d');
    if (bg) {
      x.fillStyle = bg;
      x.beginPath();
      if (radius && x.roundRect) x.roundRect(0, 0, cw, ch, Math.min(cw, ch) * radius);
      else x.rect(0, 0, cw, ch);
      x.fill();
    }
    const box = Math.min(cw, ch) * scale;
    const k = Math.min(box / w, box / h);
    x.imageSmoothingQuality = 'high';
    x.drawImage(mark, (cw - w * k) / 2, (ch - h * k) / 2, w * k, h * k);
    return o.toDataURL('image/png');
  };

  return {
    'mark.png':              make(96, 96, null, 1, 0),
    'mark@2x.png':           make(192, 192, null, 1, 0),
    'icon-180.png':          make(180, 180, ink, 0.62, 0.23),
    'icon-192.png':          make(192, 192, ink, 0.62, 0.23),
    'icon-512.png':          make(512, 512, ink, 0.62, 0.23),
    'icon-maskable-512.png': make(512, 512, ink, 0.46, 0),
    'og.png':                make(1200, 630, ink, 0.44, 0),
  };
}, { src: 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64'), ink: INK });

for (const [name, url] of Object.entries(out)) {
  fs.writeFileSync(path.join(ASSETS, name), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote assets/' + name);
}
await browser.close();
