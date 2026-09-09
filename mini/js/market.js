/**
 * The market, from the client's side.
 *
 * Reads are plain cached GETs — the catalogue is one file the server rebuilds
 * on write, so browsing costs the origin nothing once a CDN has it. The
 * expensive part of publishing, deciding whether an app is any good and what
 * it is, runs here against the submitter's own key: review costs the person
 * publishing, not the person hosting.
 */

import { state, marketBase, publishApp } from './store.js';
import { stream } from './llm.js';
import { runCheck, formatCheck } from './sandbox.js';
import { authHeaders, session } from './auth.js';

const CACHE_KEY = 'mini.market.cache';

async function api(path, opts = {}) {
  const res = await fetch(marketBase() + path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
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
    // `fresh` has to mean fresh: the catalogue is served with a two-minute
    // max-age, so without this the browser would answer from its own cache
    // and an update published a moment ago would stay invisible.
    const data = await api('/api/market/index.json', fresh ? { cache:'no-cache' } : {});
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

/** What the server offers for free, if anything. Fetched once per load. */
let configPromise = null;
export function serverConfig() {
  configPromise ||= fetch(marketBase() + '/api/config')
    .then(r => r.json())
    .catch(() => ({ free: null }));
  return configPromise;
}

/* ------------------------------------------------------------ publishing */

const REVIEW_PROMPT = `You are the moderator of an app store. You are reviewing a mini app someone built.

ACCEPT if the app works, is finished, and does something useful or genuinely fun — a game, a tool, a calculator, a tracker, a course, a book, a reference.
REJECT if it is empty or a template ("hello world"), unfinished, broken, repetitive filler, advertising or spam, adult, violent, hateful, a scam, or asks for someone else's personal data.

Pick a category from the existing ones. If none fits, invent a short, general one (for example "Games", "Tools", "Health", "Learning", "Finance", "Reading").

THE APP HAS ALREADY BEEN RUN. An automated report of that run is included below: JavaScript errors, controls that were clicked, layout problems. Judge whether it works from THAT report, not from reading the code.

NEVER reject because:
- the code you were given is cut off — long files are truncated on the way to you, and a cut end is not a syntax error;
- the style is not to your taste, the code is minified, or you would have written it differently.
Reject only for the reasons listed above, and let the automated report decide whether it runs.

Reply with JSON and nothing else:
{"ok":true|false,"score":1-5,"note":"one short reason","summary":"one sentence saying what it does","category":"slug-in-latin-letters","categoryName":"Display name","categoryIcon":"one emoji","tags":["2-4 tags"]}`;

/**
 * Runs the store review with the user's own model.
 * @returns {{ok:boolean, score:number, note:string, summary:string,
 *            category:string, categoryName:string, categoryIcon:string, tags:string[]}}
 */
export async function reviewApp(project, meta, categories = [], onProgress) {
  const s = state.settings;
  const files = Object.entries(project.files);
  const bytes = files.reduce((n, [, v]) => n + v.length, 0);

  // Run it first. A verdict about whether an app works should come from
  // watching it work, not from reading a copy of its source that had to be
  // cut short on the way — which is what used to make every review fail.
  onProgress?.('running');
  const check = await runCheck(project, { interact:true }).catch(e => ({ fatal:e.message }));
  const report = formatCheck(check);

  onProgress?.('reading');
  let budget = 90_000;
  const code = files.map(([k, v]) => {
    const share = Math.max(2000, Math.floor(budget / files.length));
    const body = v.length > share ? v.slice(0, share) + `\n… [${v.length - share} more characters of ${k} not shown]` : v;
    budget -= body.length;
    return `--- ${k} (${v.length} chars)\n${body}`;
  }).join('\n\n');

  const outline = project.course
    ? `This is a COURSE: ${project.course.modules.reduce((n, m) => n + m.lessons.length, 0)} lessons.`
    : project.book
    ? `This is a BOOK: ${project.book.chapters.length} chapters.`
    : '';

  const catList = categories.length
    ? categories.map(c => `${c.id} (${c.name})`).join(', ')
    : '(no categories yet)';

  const messages = [
    { role:'system', content: REVIEW_PROMPT },
    { role:'user', content:
      `Existing categories: ${catList}\n\nName: ${meta.name}\nIcon: ${meta.emoji}\n` +
      `Size: ${Math.round(bytes / 1024)} KB across ${files.length} files.\n${outline}\n\n` +
      `AUTOMATED RUN REPORT\n${report}\n\nSOURCE (may be truncated — that is not a defect)\n${code}` },
  ];

  let out = '';
  for await (const ev of stream({ settings: s, messages, temperature: 0 })) {
    if (ev.t === 'text') out += ev.v;
  }

  const match = out.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('The review reply could not be read');
  const r = JSON.parse(match[0]);

  return {
    ok: r.ok === true,
    score: Number(r.score) || 0,
    note: String(r.note || ''),
    summary: String(r.summary || ''),
    category: String(r.category || 'other').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24),
    categoryName: String(r.categoryName || r.category || 'Other').slice(0, 24),
    categoryIcon: String(r.categoryIcon || '📦').slice(0, 4),
    tags: Array.isArray(r.tags) ? r.tags.map(String).slice(0, 4) : [],
    model: s.model,
  };
}

export function publish({ project, meta, review }) {
  return api('/api/market/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: meta.name, emoji: meta.emoji, color: meta.color, iconImage: meta.iconImage || null,
      type: project.course ? 'course' : project.book ? 'book' : 'app',
      files: project.files, assets: project.assets || [],
      review,
    }),
  });
}

/* --------------------------------------------------------------- local */

/** The server is the authority; this only saves a round trip before trying. */
export const quotaLeft = () => session.quota?.left;
export const publishedToday = () => session.quota?.left === 0;

export function markPublished() {
  if (session.quota) session.quota.left = Math.max(0, session.quota.left - 1);
}

export const isInstalled = marketId => state.apps.some(a => a.marketId === marketId);

/**
 * Which installed apps the market has a newer version of.
 *
 * Versions are tracked by line — the same author republishing under the same
 * name — because the id carries a content hash and therefore changes with
 * every edit.
 */
export function pendingUpdates(catalogue) {
  const rows = catalogue?.apps || [];
  const out = [];
  for (const app of state.apps) {
    if (!app.marketLine) continue;
    const latest = rows.find(r => r.line === app.marketLine);
    if (latest && (latest.version || 1) > (app.marketVersion || 1)) out.push({ app, latest });
  }
  return out;
}

/** Replaces an installed app's files with the newer published version. */
export async function updateInstalled(app, latest) {
  const full = await loadApp(latest.id);
  return publishApp({
    id: app.id,
    name: full.name, emoji: full.emoji, color: full.color, iconImage: full.iconImage,
    files: full.files, assets: full.assets, deviceAccess: false,
    marketId: latest.id, marketLine: latest.line, marketVersion: latest.version,
  });
}
