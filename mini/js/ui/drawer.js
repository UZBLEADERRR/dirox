/** The left drawer: chat history, grouped the way people actually remember it. */

import { state, save, deleteChat, newChat, getRole } from '../store.js';
import { t } from '../i18n.js';
import { $, el, openSheet, closeSheet, confirmSheet as ask, svg, ICON, field } from './dom.js';
import { session } from '../auth.js';

const DAY = 864e5;

export function openDrawer() {
  renderDrawer();
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
}
export function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

export function renderDrawer(onPick) {
  const list = $('#chat-list');
  list.innerHTML = '';
  $('#t-new-chat').textContent = t('newChat');
  $('#t-settings').textContent = t('settings');

  const u = session.user;
  $('#btn-account').hidden = !u;
  if (u) {
    $('#account-avatar').textContent = (u.name || u.username).slice(0, 1).toUpperCase();
    $('#account-name').textContent = u.name || u.username;
    $('#account-handle').textContent = '@' + u.username;
  }

  const now = Date.now();
  const groups = [[t('today'), []], [t('week'), []], [t('older'), []]];
  for (const c of [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const age = now - c.updatedAt;
    (age < DAY ? groups[0] : age < 7 * DAY ? groups[1] : groups[2])[1].push(c);
  }

  for (const [label, chats] of groups) {
    if (!chats.length) continue;
    list.append(el('div', { class:'chat-group', text:label }));
    for (const c of chats) {
      const role = getRole(c.roleId);
      list.append(el('div', { class:`chat-row ${c.id === state.activeChatId ? 'active' : ''}` },
        el('button', { class:'name', onClick:() => {
          state.activeChatId = c.id; save(); closeDrawer(); window.__miniRender?.();
        }},
          `${role.emoji} ${c.title || t('newChat')}`,
          el('small', { text: c.messages.length ? `${c.messages.length} xabar` : '—' })),
        el('button', { class:'kebab', onClick:() => chatMenu(c) }, svg(ICON.kebab))));
    }
  }

  const { in:i, out:o } = state.totals;
  $('#usage').textContent = (i + o) ? `${t('usage')}: ${fmt(i + o)} ${t('tokens')}` : '';
}

const fmt = n => n > 999 ? (n / 1000).toFixed(1) + 'k' : String(n);

function chatMenu(chat) {
  openSheet(() => [
    el('h3', { text: chat.title || t('newChat') }),
    el('button', { class:'list-item', onClick:() => renameSheet(chat) },
      el('span', { class:'em', text:'✏️' }), el('span', { class:'txt' }, el('b', { text:t('rename') }))),
    el('button', { class:'list-item', onClick:async () => {
      closeSheet();
      if (await ask({ title:t('confirmDelete'), text:chat.title, ok:t('delete') })) {
        deleteChat(chat.id); renderDrawer(); window.__miniRender?.();
      }
    }}, el('span', { class:'em', text:'🗑' }),
        el('span', { class:'txt' }, el('b', { text:t('delete'), style:{ color:'var(--danger)' } }))),
  ]);
}

function renameSheet(chat) {
  openSheet(() => {
    const input = el('input', { value:chat.title || '' });
    return [
      el('h3', { text:t('rename') }),
      field(t('appName'), input),
      el('div', { class:'btn-row' },
        el('button', { class:'btn primary', text:t('save'), onClick:() => {
          chat.title = input.value.trim().slice(0, 60); save(true);
          closeSheet(); renderDrawer(); window.__miniRender?.();
        }})),
    ];
  });
}

export function startNewChat() {
  newChat(state.chats[0]?.roleId || 'builder');
  closeDrawer();
  window.__miniRender?.();
}
