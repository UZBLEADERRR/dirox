/** The market screen: browse, install, and publish what you built. */

import { state, publishApp } from '../store.js';
import { session, signedIn, refresh } from '../auth.js';
import { t } from '../i18n.js';
import * as api from '../market.js';
import { $, el, svg, ICON, openSheet, closeSheet, toast, appIcon } from './dom.js';
import { mount } from '../sandbox.js';
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

  const grid = (items) => el('div', { class:'mk-grid' }, ...items.map(card));
  if (!q && !cat) {
    body.append(el('div', { class:'mk-section', text:t('popular') }), grid(rows.slice(0, 6)));
    if (rows.length > 6) {
      const fresh = [...rows].sort((x, y) => y.createdAt - x.createdAt).slice(0, 20);
      body.append(el('div', { class:'mk-section', text:t('newest') }), grid(fresh));
    }
  } else {
    body.append(grid(rows.slice(0, 60)));
  }
}

function hero() {
  return el('div', { class:'mk-hero' },
    el('div', { class:'mk-banner' },
      el('img', { src:'assets/mark.png', alt:'' }),
      el('h3', { text:t('heroTitle') }),
      el('p', { text:t('heroSub') }),
      el('button', { class:'btn', text:t('heroCta'), onClick:() => hooks.goChat?.() })));
}

const TYPE_LABEL = { course:'Course', book:'Book' };

/** One tile in the market grid — the shape a store shelf has. */
function card(a) {
  const installed = api.isInstalled(a.id);
  const get = el('button', { class:`mk-get ${installed ? 'done' : ''}`,
    text: installed ? t('open') : t('get') });
  get.addEventListener('click', e => {
    e.stopPropagation();
    installed ? openInstalled(a.id) : install(a, get);
  });

  return el('button', { class:'mk-card', onClick:() => openDetail(a) },
    el('div', { class:'mk-top' },
      appIcon(a, 'mk-ico'),
      TYPE_LABEL[a.type] ? el('span', { class:'pill red', text:TYPE_LABEL[a.type] }) : null),
    el('b', { text:a.name }),
    el('small', { text:a.summary || a.catName || '' }),
    el('div', { class:'mk-foot' },
      el('span', { class:'mk-installs' }, svg(ICON.download), fmtCount(a.installs)),
      get));
}

/* --------------------------------------------------------------- detail */

export async function openDetail(a) {
  let running = null;

  openSheet(() => [
    el('div', { class:'center', style:{ padding:'6px 0 4px' } },
      appIcon(a, 'mk-ico big'),
      el('h3', { class:'center', style:{ marginBottom:'2px' }, text:a.name }),
      el('div', { style:{ color:'var(--muted)', fontSize:'13px' },
        text:`${TYPE_LABEL[a.type] || 'App'} · ${a.catName || ''} · ${a.author || 'anonymous'}` })),

    a.summary ? el('p', { class:'note', style:{ marginTop:'14px' }, text:a.summary }) : null,

    // A live copy, running right there, so nobody installs on faith.
    (() => {
      const frame = el('div', { class:'mk-preview' },
        el('div', { class:'mk-preview-load' }, el('span', { class:'spinner' })));
      (async () => {
        try {
          const full = await api.loadApp(a.id);
          frame.innerHTML = '';
          const stage = el('div', { class:'mk-stage' });
          frame.append(stage);
          running = mount(stage, full, { appId:'preview-' + a.id });
          // The frame is a 390px phone scaled to whatever width the sheet has.
          const fit = () => frame.style.setProperty('--pv-scale',
            String(Math.min(1, frame.clientWidth / 390)));
          fit();
          new ResizeObserver(fit).observe(frame);
        } catch {
          frame.innerHTML = '';
          frame.append(el('div', { class:'mk-preview-load', text:'Preview unavailable' }));
        }
      })();
      return el('div', {}, el('h4', { text:'Preview' }), frame);
    })(),

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
  ], { onClose: () => { running?.destroy(); running = null; } });
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
      name: full.name, emoji: full.emoji, color: full.color, iconImage: full.iconImage,
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
                      iconImage:full.iconImage, files:full.files, assets:full.assets, deviceAccess:false });
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
export async function openPublishToMarket(project, meta) {
  const s = state.settings;

  if (!signedIn()) return toast(t('loginToPublish'));
  if (!s.apiKey && !(s.useFree && session.free)) return toast(t('noKeyTitle'));

  await refresh();                         // the server owns the daily count
  if (api.publishedToday())
    return openSheet(() => [
      el('h3', { text:t('marketPublish') }),
      el('div', { class:'note warn', text:t('dailyLimit') }),
    ]);

  openSheet(close => {
    const box = el('div');
    const go = el('button', { class:'btn primary', text:t('reviewStart') });

    go.onclick = async () => {
      go.disabled = true;
      box.innerHTML = '';
      box.append(el('div', { class:'note' },
        el('div', { style:{ display:'flex', gap:'10px', alignItems:'center' } },
          el('span', { class:'spinner' }), el('span', { class:'rv-label', text:t('reviewing') }))));

      let review;
      try {
        const cats = (data?.categories || (await api.loadCatalogue().catch(() => null))?.categories) || [];
        review = await api.reviewApp(project, meta, cats, phase => {
          const label = phase === 'running' ? 'Running your app…' : t('reviewing');
          box.querySelector('.rv-label') && (box.querySelector('.rv-label').textContent = label);
        });
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
          const res = await api.publish({ project, meta, review });
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
      el('div', { class:'note', style:{ marginTop:'10px' },
        text:`${t('author')}: ${session.user?.name || ''} (@${session.user?.username || ''})` }),
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
