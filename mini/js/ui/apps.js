/** The home screen of mini-apps, and the player that runs one. */

import { state, getApp, appData } from '../store.js';
import { t } from '../i18n.js';
import { mount, printableHtml } from '../sandbox.js';
import { restoreIdentity, applyAppIdentity } from '../icons.js';
import { openAppMenu } from './sheets.js';
import { $, el, svg, ICON, pushHistory, toast, appIcon } from './dom.js';

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
      appIcon(app),
      el('span', { text:app.name }));

    const menu = () => openAppMenu(app, {
      onOpen: () => openApp(app),
      onEdit: () => hooks.editApp?.(app),
      onMarket: () => hooks.onMarket?.(app),
      onPrint: () => printApp(app),
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
  // The chrome takes on the app's colour, so a running app feels like itself.
  player.style.setProperty('--app-accent', app.color || 'transparent');
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
      onMarket: () => { closeApp(); hooks.onMarket?.(real); },
      onPrint: () => printApp(real),
      onChanged: () => { closeApp(); renderApps(); },
    });
  };
}

/**
 * Opens a script-free copy in a normal window and asks the browser to print
 * it. On a phone that dialog offers "Save as PDF", which is how a course or a
 * book leaves this app as a real document.
 */
export function printApp(app) {
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to save a PDF');
  w.document.open();
  w.document.write(printableHtml(app, appData(app.id || 'draft')));
  w.document.close();
  const go = () => setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 350);
  w.document.readyState === 'complete' ? go() : w.addEventListener('load', go);
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
