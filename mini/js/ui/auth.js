/** The sign-in screen: two fields to come back, three to start. */

import { t } from '../i18n.js';
import * as auth from '../auth.js';
import { $, $$, el, toast, openSheet, closeSheet, confirmSheet, field } from './dom.js';

let mode = 'login', onDone = null, busy = false;

export function showAuth(done) {
  onDone = done;
  $('#boot').hidden = true;
  $('#auth-screen').hidden = false;
  paint();
}

export function hideAuth() { $('#auth-screen').hidden = true; }

function paint() {
  const reg = mode === 'register';
  $('#auth-sub').textContent = t('emptySub');
  $('#auth-tab-login').textContent = t('signIn');
  $('#auth-tab-register').textContent = t('signUp');
  $$('#auth-tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#field-name').hidden = !reg;
  $('#auth-submit').textContent = reg ? t('signUp') : t('signIn');
  $('#auth-password').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  $('#auth-fine').textContent = reg ? t('authFine') : '';
  $('#auth-error').hidden = true;
}

function fail(msg) {
  const box = $('#auth-error');
  box.textContent = msg;
  box.hidden = false;
}

export function bindAuth() {
  $$('#auth-tabs button').forEach(b => {
    b.onclick = () => { mode = b.dataset.mode; paint(); };
  });

  $('#auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    const btn = $('#auth-submit');
    const fields = {
      name: $('#auth-name').value.trim(),
      username: $('#auth-username').value.trim().toLowerCase(),
      password: $('#auth-password').value,
    };
    if (!fields.username || !fields.password) return fail(t('fillAll'));

    busy = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '…';
    try {
      mode === 'register' ? await auth.register(fields) : await auth.login(fields);
      $('#auth-password').value = '';
      hideAuth();
      onDone?.();
    } catch (err) {
      fail(err.message);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

/* --------------------------------------------------------------- account */

export function openAccount(afterChange) {
  const u = auth.session.user;
  if (!u) return;

  openSheet(() => [
    el('div', { class:'center', style:{ padding:'4px 0 16px' } },
      el('div', { class:'app-ico', style:{ background:'var(--accent)', margin:'0 auto',
        color:'#fff', fontSize:'26px', fontWeight:'700' },
        text:(u.name || u.username).slice(0, 1).toUpperCase() }),
      el('div', { style:{ marginTop:'10px', fontWeight:700, fontSize:'17px' }, text:u.name }),
      el('div', { style:{ color:'var(--muted)', fontSize:'13.5px' }, text:'@' + u.username })),

    el('div', { class:'stat-row' },
      el('div', { class:'stat' }, el('b', { text:String(u.apps || 0) }), el('small', { text:t('published') })),
      el('div', { class:'stat' }, el('b', { text:String(auth.session.quota?.left ?? '—') }),
        el('small', { text:t('leftToday') })),
      el('div', { class:'stat' }, el('b', { text:String(u.daysLeft ?? '—') }),
        el('small', { text:t('daysLeft') }))),

    el('div', { class:'note', text:t('inactiveNote').replace('{n}', u.inactiveDays ?? 30) }),

    el('button', { class:'list-item', style:{ marginTop:'10px' }, onClick:() => openPassword() },
      el('span', { class:'em', text:'🔑' }), el('span', { class:'txt' }, el('b', { text:t('changePassword') }))),

    el('button', { class:'list-item', onClick:async () => {
      closeSheet();
      if (await confirmSheet({ title:t('signOut'), text:t('signOutNote'), ok:t('signOut'), danger:false })) {
        auth.logout();
        location.reload();
      }
    }}, el('span', { class:'em', text:'🚪' }), el('span', { class:'txt' }, el('b', { text:t('signOut') }))),

    el('button', { class:'list-item', onClick:async () => {
      closeSheet();
      if (await confirmSheet({ title:t('deleteAccount'), text:t('deleteAccountNote'), ok:t('delete') })) {
        try { await auth.deleteAccount(); } catch (e) { toast(e.message); return; }
        auth.wipeLocal();
        location.reload();
      }
    }}, el('span', { class:'em', text:'🗑' }),
        el('span', { class:'txt' }, el('b', { text:t('deleteAccount'), style:{ color:'var(--danger)' } }))),
  ], { onClose: afterChange });
}

function openPassword() {
  openSheet(close => {
    const cur = el('input', { type:'password', autocomplete:'current-password' });
    const next = el('input', { type:'password', autocomplete:'new-password', minlength:'6' });
    const err = el('div', { class:'note warn', hidden:true });
    return [
      el('h3', { text:t('changePassword') }),
      field(t('currentPassword'), cur),
      field(t('newPassword'), next),
      err,
      el('div', { class:'btn-row' },
        el('button', { class:'btn primary', text:t('save'), onClick:async () => {
          try {
            await auth.changePassword({ current: cur.value, next: next.value });
            close(); toast(t('done'));
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        }})),
    ];
  });
}
