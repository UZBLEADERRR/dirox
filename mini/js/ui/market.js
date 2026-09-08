/** The market screen: browse, install, and publish what you built. */

import { state, save, publishApp, getApp } from '../store.js';
import { t } from '../i18n.js';
import * as api from '../market.js';
import { $, el, svg, ICON, openSheet, closeSheet, toast, field, confirmSheet } from './dom.js';
import { openAddToHome } from './sheets.js';

let cat = null, query = '', data = null, loading = false, hooks = {};

export function initMarket(h) { hooks = h; }

const fmtCount = n => n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k' : String(n || 0);
const fmtSize  = n => n >= 1024 * 100 ? Math.round(n / 1024) + ' KB' : Math.round(n / 102.4) / 10 + ' KB';

/* --------------------------------------------------------------- screen */

export async function renderMarket({ refresh = false } = {}) {
  const body = $('#market-body');
  const cats = $('#market-cats');

  if (!data || refresh) {
    if (loading) return;
    loading = true;
    if (!data) body.innerHTML = '<div class="market-empty"><div class="spinner" style="margin:0 auto"></div></div>';
    try { data = await api.loadCatalogue({ fresh: refresh }); }
    catch (e) {
      loading = false;
      body.innerHTML = '';
      body.append(el('div', { class:'market-empty' },
        el('div', { text:'Market ochilmadi.' }),
        el('div', { style:{ fontSize:'12.5px', marginTop:'6px', opacity:.7 }, text:e.message }),
        el('button', { class:'chip', style:{ marginTop:'16px' }, text:t('retry'),
          onClick:() => renderMarket({ refresh:true }) })));
      return;
    }
    loading = false;
  }

  /* categories */
  cats.innerHTML = '';
  cats.append(el('button', { class:`cat ${cat ? '' : 'on'}`, text:t('all'),
    onClick:() => { cat = null; renderMarket(); } }));
  for (const c of data.categories) {
    cats.append(el('button', { class:`cat ${cat === c.id ? 'on' : ''}`,
      text:`${c.icon} ${c.name}`, onClick:() => { cat = c.id; renderMarket(); } }));
  }

  /* rows */
  const q = query.trim().toLowerCase();
  const rows = data.apps.filter(a =>
    (!cat || a.cat === cat) &&
    (!q || a.name.toLowerCase().includes(q) || (a.summary || '').toLowerCase().includes(q)
        || (a.tags || []).some(tag => tag.toLowerCase().includes(q))));

  body.innerHTML = '';
  if (!q && !cat) body.append(hero());

  if (!rows.length) {
    body.append(el('div', { class:'market-empty', text: data.apps.length ? t('nothingFound') : t('marketEmpty') }));
    return;
  }

  const list = el('div', { class:'market-list' });
  if (!q && !cat) {
    list.append(el('div', { class:'mk-section', text:t('popular') }));
    for (const a of rows.slice(0, 8)) list.append(row(a));
    if (rows.length > 8) {
      list.append(el('div', { class:'mk-section', text:t('newest') }));
      for (const a of [...rows].sort((x, y) => y.createdAt - x.createdAt).slice(0, 20)) list.append(row(a));
    }
  } else {
    for (const a of rows.slice(0, 60)) list.append(row(a));
  }
  body.append(list);
}

function hero() {
  return el('div', { class:'mk-hero' },
    el('div', { class:'mk-banner' },
      el('img', { src:'assets/mark.png', alt:'' }),
      el('h3', { text:t('heroTitle') }),
      el('p', { text:t('heroSub') }),
      el('button', { class:'btn', text:t('heroCta'), onClick:() => hooks.goChat?.() })));
}

function row(a) {
  const installed = api.isInstalled(a.id);
  const get = el('button', { class:`mk-get ${installed ? 'done' : ''}`,
    text: installed ? t('open') : t('get') });
  get.addEventListener('click', e => {
    e.stopPropagation();
    installed ? openInstalled(a.id) : install(a, get);
  });

  return el('button', { class:'mk-row', onClick:() => openDetail(a) },
    el('div', { class:'mk-ico', style:{ background:a.color || 'var(--accent)' }, text:a.emoji || '📦' }),
    el('div', { class:'mk-body' },
      el('b', { text:a.name }),
      el('small', { text:a.summary || a.catName || '' }),
      el('div', { class:'meta' },
        el('span', { text:`⬇ ${fmtCount(a.installs)}` }),
        el('span', { text:fmtSize(a.size) }),
        a.catName ? el('span', { text:a.catName }) : null)),
    get);
}

/* --------------------------------------------------------------- detail */

export async function openDetail(a) {
  openSheet(() => [
    el('div', { class:'center', style:{ padding:'6px 0 4px' } },
      el('div', { class:'mk-ico', style:{ background:a.color || 'var(--accent)', margin:'0 auto',
        width:'76px', height:'76px', borderRadius:'21px', fontSize:'38px' }, text:a.emoji || '📦' }),
      el('h3', { class:'center', style:{ marginBottom:'2px' }, text:a.name }),
      el('div', { style:{ color:'var(--muted)', fontSize:'13px' },
        text:`${a.catName || ''} · ${a.author || 'anonim'}` })),

    a.summary ? el('p', { class:'note', style:{ marginTop:'14px' }, text:a.summary }) : null,

    el('div', { class:'stat-row' },
      el('div', { class:'stat' }, el('b', { text:fmtCount(a.installs) }), el('small', { text:t('installs') })),
      el('div', { class:'stat' }, el('b', { text:fmtSize(a.size) }), el('small', { text:t('size') })),
      el('div', { class:'stat' }, el('b', { text:new Date(a.createdAt).toLocaleDateString() }),
        el('small', { text:t('added') }))),

    (a.tags || []).length
      ? el('div', { style:{ display:'flex', gap:'6px', flexWrap:'wrap', marginBottom:'6px' } },
          ...a.tags.map(tag => el('span', { class:'pill', text:'#' + tag })))
      : null,

    el('div', { class:'btn-row' },
      el('button', { class:'btn', text:t('preview'), onClick:() => preview(a) }),
      installButton(a)),

    el('button', { class:'btn', style:{ marginTop:'9px' }, text:t('share'), onClick:() => shareApp(a) }),
  ]);
}

function installButton(a) {
  const installed = api.isInstalled(a.id);
  const b = el('button', { class:'btn primary', text: installed ? t('open') : t('install') });
  b.onclick = () => installed ? openInstalled(a.id) : install(a, b);
  return b;
}

function openInstalled(marketId) {
  const local = state.apps.find(x => x.marketId === marketId);
  if (local) { closeSheet(); hooks.openApp?.(local); }
}

async function install(a, button) {
  const label = button.textContent;
  button.disabled = true;
  button.innerHTML = '';
  button.append(el('span', { class:'spinner' }));
  try {
    const full = await api.loadApp(a.id);
    const app = publishApp({
      name: full.name, emoji: full.emoji, color: full.color,
      files: full.files, assets: full.assets, deviceAccess: false,
      marketId: a.id,
    });
    api.countInstall(a.id);
    a.installs = (a.installs || 0) + 1;
    toast(`${full.name} — ${t('installed')}`);
    closeSheet();
    renderMarket();
    openAddToHome(app);
  } catch (e) {
    button.disabled = false;
    button.textContent = label;
    toast(`${t('error')}: ${e.message}`);
  }
}

async function preview(a) {
  toast(t('loading'));
  try {
    const full = await api.loadApp(a.id);
    closeSheet();
    hooks.openApp?.({ id:'market-' + a.id, name:full.name, emoji:full.emoji, color:full.color,
                      files:full.files, assets:full.assets, deviceAccess:false });
  } catch (e) { toast(`${t('error')}: ${e.message}`); }
}

async function shareApp(a) {
  const url = `${location.origin}${location.pathname}?m=${a.id}`;
  try { await navigator.share({ title:a.name, text:a.summary || '', url }); }
  catch {
    try { await navigator.clipboard.writeText(url); toast(t('copied')); } catch { toast(url); }
  }
}

/** Opens a shared market link straight into its detail sheet. */
export async function openSharedApp(id) {
  try {
    data = data || await api.loadCatalogue();
    const row = data.apps.find(x => x.id === id);
    if (row) return openDetail(row);
    const full = await api.loadApp(id);
    openDetail({ id, name:full.name, emoji:full.emoji, color:full.color, summary:full.summary,
                 catName:full.catName, author:full.author, tags:full.tags, size:full.size,
                 installs:full.installs || 0, createdAt:full.createdAt || Date.now() });
  } catch (e) { toast(`${t('error')}: ${e.message}`); }
}

/* ------------------------------------------------------------- publishing */

/**
 * Publishing is a review, then a submit. The review runs on the user's own
 * model — the same key they build with — so the store costs its host nothing
 * to police.
 */
export function openPublishToMarket(project, meta) {
  const s = state.settings;

  if (!s.apiKey || !s.model)
    return toast(t('noKeyTitle'));

  if (api.publishedToday())
    return openSheet(() => [
      el('h3', { text:t('marketPublish') }),
      el('div', { class:'note warn', text:t('dailyLimit') }),
    ]);

  openSheet(close => {
    const author = el('input', { value:s.author || '', placeholder:'anonim', maxlength:'24' });
    const box = el('div');
    const go = el('button', { class:'btn primary', text:t('reviewStart') });

    go.onclick = async () => {
      s.author = author.value.trim().slice(0, 24); save();
      go.disabled = true;
      box.innerHTML = '';
      box.append(el('div', { class:'note' },
        el('div', { style:{ display:'flex', gap:'10px', alignItems:'center' } },
          el('span', { class:'spinner' }), el('span', { text:t('reviewing') }))));

      let review;
      try {
        const cats = (data?.categories || (await api.loadCatalogue().catch(() => null))?.categories) || [];
        review = await api.reviewApp(project, meta, cats);
      } catch (e) {
        box.innerHTML = '';
        box.append(el('div', { class:'note warn', text:`${t('error')}: ${e.message}` }));
        go.disabled = false;
        return;
      }

      box.innerHTML = '';
      box.append(verdictCard(review));

      if (!review.ok) {
        go.textContent = t('close');
        go.disabled = false;
        go.onclick = close;
        return;
      }

      go.textContent = t('marketSend');
      go.disabled = false;
      go.onclick = async () => {
        go.disabled = true;
        try {
          const res = await api.publish({ project, meta, review, author: s.author || 'anonim' });
          api.markPublished();
          box.innerHTML = '';
          box.append(el('div', { class:'note ok',
            text: res.status === 'live' ? t('marketLive') : t('marketPending') }));
          go.textContent = t('done');
          go.disabled = false;
          go.onclick = () => { close(); renderMarket({ refresh:true }); };
        } catch (e) {
          box.append(el('div', { class:'note warn', text:`${t('error')}: ${e.message}` }));
          go.disabled = false;
        }
      };
    };

    return [
      el('h3', { text:t('marketPublish') }),
      el('div', { class:'note', text:t('marketHow') }),
      el('div', { style:{ height:'14px' } }),
      field(t('author'), author, t('authorHint')),
      box,
      el('div', { class:'btn-row' }, go),
    ];
  });
}

function verdictCard(r) {
  return el('div', { class:`verdict ${r.ok ? 'ok' : 'no'}` },
    el('div', { class:'mark' }, svg(r.ok ? ICON.check : ICON.x)),
    el('div', {},
      el('b', { text: r.ok ? `${t('reviewPassed')} · ${'★'.repeat(Math.max(1, Math.min(5, r.score)))}`
                          : t('reviewFailed') }),
      el('span', { text: r.note || r.summary || '' }),
      r.ok ? el('span', { style:{ display:'block', marginTop:'6px' },
        text:`${t('category')}: ${r.categoryIcon} ${r.categoryName}` }) : null));
}

/* --------------------------------------------------------------- wiring */

export function bindMarketControls() {
  const search = $('#market-search');
  let timer = null;
  search.addEventListener('input', () => {
    query = search.value;
    clearTimeout(timer);
    timer = setTimeout(() => renderMarket(), 160);
  });
}

export const marketData = () => data;
