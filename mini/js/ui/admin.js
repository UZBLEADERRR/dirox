/**
 * The admin panel.
 *
 * Everything here already existed as an endpoint; this is the screen for it,
 * so running the thing does not mean keeping a curl cheat sheet. Two ways in:
 * an account named in MINI_ADMIN_USERS, which needs no token at all, or the
 * token pasted once and kept on this device.
 */

import { state, marketBase } from '../store.js';
import { t } from '../i18n.js';
import { session } from '../auth.js';
import { authHeaders } from '../auth.js';
import { $, el, openSheet, closeSheet, confirmSheet, field, toast, iconTile, ICON, svg } from './dom.js';

const TOKEN_KEY = 'mini.admintoken';

export const adminToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const setToken = v => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} };

export const canAdmin = () => !!(session.user?.isAdmin || adminToken());

async function call(path, opts = {}) {
  const res = await fetch(marketBase() + '/api/admin/' + path, {
    ...opts,
    headers: { 'Content-Type':'application/json', ...authHeaders(),
               ...(adminToken() ? { 'X-Admin-Token': adminToken() } : {}), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ gate */

export function openAdmin() {
  if (!canAdmin()) return openTokenGate();
  openPanel();
}

function openTokenGate() {
  openSheet(close => {
    const input = el('input', { type:'password', placeholder:'MINI_ADMIN_TOKEN',
      autocapitalize:'off', spellcheck:'false' });
    const err = el('div', { class:'note warn', hidden:true });
    return [
      el('h3', { text:'Admin' }),
      el('div', { class:'note', text:
        'Put your username in MINI_ADMIN_USERS on the server and this panel opens by itself. ' +
        'Otherwise paste the admin token once — it stays on this device.' }),
      el('div', { style:{ height:'12px' } }),
      field('Admin token', input),
      err,
      el('div', { class:'btn-row' },
        el('button', { class:'btn primary', text:'Unlock', onClick:async () => {
          setToken(input.value.trim());
          try { await call('stats'); close(); openPanel(); }
          catch (e) { setToken(''); err.textContent = e.message; err.hidden = false; }
        }})),
    ];
  });
}

/* ----------------------------------------------------------------- panel */

async function openPanel() {
  let stats = null;
  try { stats = await call('stats'); }
  catch (e) { setToken(''); return toast(`Admin: ${e.message}`); }

  openSheet(() => [
    el('h3', { text:'Admin' }),

    el('div', { class:'stat-row' },
      el('div', { class:'stat' }, el('b', { text:String(stats.users) }), el('small', { text:'accounts' })),
      el('div', { class:'stat' }, el('b', { text:String(stats.apps) }), el('small', { text:'apps' })),
      el('div', { class:'stat' }, el('b', { text:String(stats.installs) }), el('small', { text:'installs' }))),

    stats.pending
      ? el('div', { class:'note warn', text:`${stats.pending} waiting for review` })
      : null,

    el('h4', { text:'Free model' }),
    el('div', { class:'note', text: stats.free
      ? `${stats.free.label} — ${stats.free.model}, ${stats.free.perDay} messages a day per account. Paid from your API account.`
      : 'Nothing configured. Users need their own API key.' }),
    el('button', { class:'list-item', onClick:() => openFreeModel(stats) },
      iconTile(ICON.sparkle, 'red'),
      el('span', { class:'txt' }, el('b', { text: stats.free ? 'Change it' : 'Set one up' }),
        el('small', { text:'Base URL, key, model and the daily allowance' }))),

    el('h4', { text:'Market' }),
    stats.pending ? el('button', { class:'list-item', onClick:() => openQueue('pending') },
      iconTile(ICON.check),
      el('span', { class:'txt' }, el('b', { text:'Review queue' }),
        el('small', { text:`${stats.pending} submitted` }))) : null,
    el('button', { class:'list-item', onClick:() => openQueue('apps') },
      iconTile(ICON.grid),
      el('span', { class:'txt' }, el('b', { text:'All apps' }),
        el('small', { text:`${stats.apps} live · remove anything` }))),
    el('button', { class:'list-item', onClick:() => openUsers() },
      iconTile(ICON.key),
      el('span', { class:'txt' }, el('b', { text:'Accounts' }),
        el('small', { text:`${stats.users} · inactive ones are swept automatically` }))),
    el('button', { class:'list-item', onClick:async () => {
      const r = await call('sweep', { method:'POST' }).catch(e => ({ error:e.message }));
      toast(r.error ? r.error : `${r.removed?.length || 0} inactive accounts removed`);
    }}, iconTile(ICON.trash),
      el('span', { class:'txt' }, el('b', { text:'Sweep inactive accounts now' }))),

    el('div', { class:'note', style:{ marginTop:'16px' },
      text:`Moderation is ${stats.moderate ? 'on — nothing goes live until you approve it' : 'off — apps go live once the AI passes them'}. Set MINI_MODERATE=1 to change that.` }),
  ]);
}

/* ------------------------------------------------------------ free model */

function openFreeModel(stats) {
  openSheet(close => {
    const base = el('input', { value: stats.free ? '' : 'https://openrouter.ai/api/v1',
      placeholder:'https://openrouter.ai/api/v1', autocapitalize:'off', spellcheck:'false' });
    const key = el('input', { type:'password', placeholder: stats.free ? '(unchanged)' : 'sk-or-v1-…',
      autocapitalize:'off', spellcheck:'false' });
    const model = el('input', { value: stats.free?.model || '',
      placeholder:'google/gemini-2.0-flash-001', autocapitalize:'off', spellcheck:'false' });
    const label = el('input', { value: stats.free?.label || 'Free model', maxlength:'40' });
    const perDay = el('input', { type:'number', min:'1', max:'500', value: String(stats.free?.perDay || 30) });
    const err = el('div', { class:'note warn', hidden:true });

    return [
      el('h3', { text:'Free model' }),
      el('div', { class:'note', text:
        'Requests go through your server with this key. It is never sent to a browser. ' +
        'Cost is roughly the daily allowance times the number of active accounts, so pick something cheap.' }),
      el('div', { style:{ height:'12px' } }),
      field('Provider base URL', base),
      field('API key', key, stats.free ? 'Leave empty to keep the current key.' : ''),
      field('Model id', model),
      field('Shown to users as', label),
      field('Messages per account per day', perDay),
      err,
      el('div', { class:'btn-row' },
        stats.free ? el('button', { class:'btn danger', text:'Turn off', onClick:async () => {
          await call('config', { method:'POST', body: JSON.stringify({ clear:true }) });
          close(); toast('Free model turned off');
        }}) : null,
        el('button', { class:'btn primary', text:t('save'), onClick:async () => {
          try {
            await call('config', { method:'POST', body: JSON.stringify({
              baseUrl: base.value.trim() || undefined,
              key: key.value.trim() || undefined,
              model: model.value.trim(),
              label: label.value.trim(),
              perDay: Number(perDay.value) || 30,
            }) });
            close(); toast('Saved');
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        }})),
    ];
  });
}

/* ---------------------------------------------------------------- queues */

async function openQueue(which) {
  const rows = await call(which).catch(e => { toast(e.message); return []; });
  openSheet(() => [
    el('h3', { text: which === 'pending' ? 'Review queue' : 'All apps' }),
    rows.length ? null : el('div', { class:'note', text:'Nothing here.' }),
    ...rows.map(a => el('div', { class:'list-item' },
      el('div', { class:'mk-ico', style:{ background:a.color || 'var(--accent)', width:'42px',
        height:'42px', borderRadius:'13px', fontSize:'21px' }, text:a.emoji || '📦' }),
      el('span', { class:'txt' },
        el('b', { text:`${a.name} ${a.version > 1 ? 'v' + a.version : ''}` }),
        el('small', { text:`${a.author || '—'} · ${a.catName || a.cat} · ${a.status}` })),
      el('span', { style:{ display:'flex', gap:'6px' } },
        a.status !== 'live' ? el('button', { class:'mk-get', text:'PUBLISH', onClick:async () => {
          await call(`publish?id=${encodeURIComponent(a.id)}`, { method:'POST' }).catch(e => toast(e.message));
          closeSheet(); openQueue(which);
        }}) : null,
        el('button', { class:'mk-get', style:{ color:'var(--danger)' }, text:'REMOVE', onClick:async () => {
          if (!await confirmSheet({ title:'Remove ' + a.name + '?', ok:t('delete') })) return openQueue(which);
          await call(`remove?id=${encodeURIComponent(a.id)}`, { method:'POST' }).catch(e => toast(e.message));
          openQueue(which);
        }})))),
  ]);
}

async function openUsers() {
  const rows = await call('users').catch(e => { toast(e.message); return []; });
  const fmt = ts => new Date(ts).toLocaleDateString();
  openSheet(() => [
    el('h3', { text:'Accounts' }),
    el('div', { class:'note', text:`${rows.length} accounts. An account unused for ${rows[0]?.inactiveDays ?? 30} days is removed automatically; its published apps stay.` }),
    ...rows.slice(0, 200).map(u => el('div', { class:'list-item' },
      el('span', { class:'avatar', text:(u.name || u.username).slice(0, 1).toUpperCase() }),
      el('span', { class:'txt' },
        el('b', { text:`${u.name} ${u.isAdmin ? '· admin' : ''}` }),
        el('small', { text:`@${u.username} · ${u.apps} published · joined ${fmt(u.createdAt)} · ${u.daysLeft}d left` })))),
  ]);
}
