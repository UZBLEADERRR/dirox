/**
 * The market, from the client's side.
 *
 * Reads are plain cached GETs — the catalogue is one file the server rebuilds
 * on write, so browsing costs the origin nothing once a CDN has it. The
 * expensive part of publishing, deciding whether an app is any good and what
 * it is, runs here against the submitter's own key: review costs the person
 * publishing, not the person hosting.
 */

import { state, save, uid } from './store.js';
import { stream } from './llm.js';

export const marketBase = () =>
  (state.settings.marketUrl || location.origin).replace(/\/+$/, '');

/** A stable, anonymous id so "one publish a day" means something. */
export function deviceId() {
  if (!state.deviceId) { state.deviceId = uid() + uid(); save(true); }
  return state.deviceId;
}

const CACHE_KEY = 'mini.market.cache';

async function api(path, opts = {}) {
  const res = await fetch(marketBase() + path, {
    ...opts,
    headers: { 'X-Mini-Device': deviceId(), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------------------------------------- reading */

/** Catalogue with a local copy, so the market opens instantly and offline. */
export async function loadCatalogue({ fresh = false } = {}) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch {}
  if (cached && !fresh && Date.now() - cached.at < 5 * 60_000) return cached.data;

  try {
    const data = await api('/api/market/index.json');
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch {}
    return data;
  } catch (e) {
    if (cached) return cached.data;
    throw e;
  }
}

export const loadApp = id => api(`/api/market/app/${encodeURIComponent(id)}.json`);

export const countInstall = id =>
  api(`/api/market/install/${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {});

export const remoteQuota = () => api('/api/market/quota').catch(() => null);

/* ------------------------------------------------------------ publishing */

const REVIEW_PROMPT = `Sen ilovalar do'koni moderatorisan. Foydalanuvchi yasagan mini ilovani ko'rib chiqasan.

QABUL QIL, agar ilova: ishlaydigan, tugallangan va biror foydali yoki qiziqarli ish qilsa (o'yin, asbob, kalkulyator, trekker, ta'lim va h.k.).
RAD ET, agar ilova: bo'sh yoki namuna ("Salom dunyo"), tugallanmagan, buzilgan, takrorlanuvchi axlat, reklama/spam, kattalar uchun, zo'ravonlik, nafrat, firibgarlik yoki boshqa birovning shaxsiy ma'lumotini so'raydigan bo'lsa.

Kategoriyani mavjudlaridan tanla. Hech biri to'g'ri kelmasa — yangi, qisqa va umumiy kategoriya o'ylab top (masalan "O'yinlar", "Asboblar", "Sog'liq", "Ta'lim", "Moliya", "Ijod").

FAQAT JSON qaytar, boshqa hech narsa:
{"ok":true|false,"score":1-5,"note":"qisqa sabab","summary":"1 jumlada ilova nima qiladi","category":"slug-lotin-harflarda","categoryName":"Ko'rinadigan nom","categoryIcon":"bitta emoji","tags":["2-4 ta teg"]}`;

/**
 * Runs the store review with the user's own model.
 * @returns {{ok:boolean, score:number, note:string, summary:string,
 *            category:string, categoryName:string, categoryIcon:string, tags:string[]}}
 */
export async function reviewApp(project, meta, categories = []) {
  const s = state.settings;
  const html = project.files['index.html'] || '';
  const code = Object.entries(project.files)
    .map(([k, v]) => `--- ${k}\n${v.slice(0, 6000)}`).join('\n\n').slice(0, 16000);

  const catList = categories.length
    ? categories.map(c => `${c.id} (${c.name})`).join(', ')
    : '(hali kategoriya yo\'q)';

  const messages = [
    { role:'system', content: REVIEW_PROMPT },
    { role:'user', content:
      `Mavjud kategoriyalar: ${catList}\n\nIlova nomi: ${meta.name}\nBelgisi: ${meta.emoji}\n` +
      `Hajmi: ${Math.round(html.length / 1024)} KB\n\nKodi:\n${code}` },
  ];

  let out = '';
  for await (const ev of stream({ settings: s, messages, temperature: 0 })) {
    if (ev.t === 'text') out += ev.v;
  }

  const match = out.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Tekshiruv javobi tushunarsiz');
  const r = JSON.parse(match[0]);

  return {
    ok: r.ok === true,
    score: Number(r.score) || 0,
    note: String(r.note || ''),
    summary: String(r.summary || ''),
    category: String(r.category || 'boshqa').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24),
    categoryName: String(r.categoryName || r.category || 'Boshqa').slice(0, 24),
    categoryIcon: String(r.categoryIcon || '📦').slice(0, 4),
    tags: Array.isArray(r.tags) ? r.tags.map(String).slice(0, 4) : [],
    model: s.model,
  };
}

export function publish({ project, meta, review, author }) {
  return api('/api/market/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: meta.name, emoji: meta.emoji, color: meta.color,
      files: project.files, assets: project.assets || [],
      author, review,
    }),
  });
}

/* --------------------------------------------------------------- local */

export const publishedToday = () =>
  state.lastPublish === new Date().toISOString().slice(0, 10);

export function markPublished() {
  state.lastPublish = new Date().toISOString().slice(0, 10);
  save(true);
}

export const isInstalled = marketId => state.apps.some(a => a.marketId === marketId);
