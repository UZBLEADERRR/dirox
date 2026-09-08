/** The home screen of mini-apps, and the player that runs one. */

import { state, getApp } from '../store.js';
import { t } from '../i18n.js';
import { mount } from '../sandbox.js';
import { restoreIdentity, applyAppIdentity } from '../icons.js';
import { openAppMenu } from './sheets.js';
import { $, el, svg, ICON, pushHistory } from './dom.js';

let running = null;
let hooks = {};

export function initApps(h) { hooks = h; }

/* ----------------------------------------------------------------- grid */

export function renderApps() {
  const grid = $('#apps-grid');
  grid.innerHTML = '';
  $('#apps-title').textContent = t('apps');

  if (!state.apps.length) {
    grid.append(el('div', { class:'apps-empty', text:t('noApps') }));
    return;
  }

  for (const app of state.apps) {
    let held = false, timer = null;
    const tile = el('button', { class:'app-tile' },
      el('div', { class:'app-ico', style:{ background:app.color || '#7c8cff' }, text:app.emoji || '📱' }),
      el('span', { text:app.name }));

    const menu = () => openAppMenu(app, {
      onOpen: () => openApp(app),
      onEdit: () => hooks.editApp?.(app),
      onChanged: renderApps,
    });

    tile.addEventListener('pointerdown', () => {
      held = false;
      timer = setTimeout(() => { held = true; navigator.vibrate?.(10); menu(); }, 480);
    });
    ['pointerup','pointerleave','pointercancel'].forEach(ev =>
      tile.addEventListener(ev, () => clearTimeout(timer)));
    tile.addEventListener('click', e => { e.preventDefault(); if (!held) openApp(app); });
    tile.addEventListener('contextmenu', e => { e.preventDefault(); menu(); });

    grid.append(tile);
  }
}

/* --------------------------------------------------------------- player */

/** `bare` = launched straight from the home-screen icon: no chrome, just the app. */
export function openApp(app, { bare = false } = {}) {
  const reopening = !$('#player').hidden;
  closeApp();
  const player = $('#player');
  player.hidden = false;
  if (!bare && !reopening) pushHistory();
  player.classList.toggle('bare', bare);
  $('#player-name').textContent = app.name || '';

  running = mount($('#player-stage'), app, {
    appId: app.id || 'draft',
    device: !!app.deviceAccess,
  });

  if (bare) {
    const home = el('button', { class:'fab-home', onClick:() => {
      history.replaceState(null, '', location.pathname);
      closeApp(); hooks.leaveBare?.();
    }}, svg(ICON.home));
    player.appendChild(home);
  }

  if (app.id && app.id !== 'draft') applyAppIdentity(app);

  $('#btn-player-menu').onclick = () => {
    const real = getApp(app.id);
    if (!real) return openAppMenu(app, { draft:true });
    openAppMenu(real, {
      onOpen: () => openApp(real),
      onEdit: () => { closeApp(); hooks.editApp?.(real); },
      onChanged: () => { closeApp(); renderApps(); },
    });
  };
}

export function closeApp() {
  running?.destroy();
  running = null;
  const player = $('#player');
  player.hidden = true;
  player.querySelector('.fab-home')?.remove();
  $('#player-stage').innerHTML = '';
  restoreIdentity();
}

export const playerOpen = () => !$('#player').hidden;
