/** Boot, routing, and the handful of global listeners the app needs. */

import { state, save, activeChat, newChat, setQuotaHandler, getApp } from './store.js';
import { setLang, t } from './i18n.js';
import { applyTheme, openSettings, openRolePicker } from './ui/sheets.js';
import { initChat, renderChat, send, stop, attachFiles, addPending } from './ui/chat.js';
import { initApps, renderApps, openApp, closeApp } from './ui/apps.js';
import { openDrawer, closeDrawer, renderDrawer, startNewChat } from './ui/drawer.js';
import { $, el, toast, openSheet, closeSheet, sheetOpen, readImage,
         pushHistory as push, popHistory as back, notePop, resetHistory } from './ui/dom.js';

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ------------------------------------------------------------------ boot */

setLang(state.settings.lang);
applyTheme();
window.__miniRender = () => { renderChat(); renderDrawer(); };

setQuotaHandler(() => toast('Xotira to\'ldi. Eski chatlarni o\'chiring.', 4000));

initChat({ openApp: (draft) => openApp(draft) });
initApps({
  /* "Edit" reopens the chat that built the app, or starts a fresh one seeded
     with its files so the agent can carry on from where it left off. */
  editApp(app) {
    const target = state.chats.find(c => c.appId === app.id);
    if (target) {
      state.activeChatId = target.id;
    } else {
      const chat = newChat('builder');
      chat.title = app.name;
      chat.project = { files: structuredClone(app.files), assets: structuredClone(app.assets || []) };
      chat.appId = app.id;
    }
    save();
    if (!$('#apps-screen').hidden) { $('#apps-screen').hidden = true; back(); }
    window.__miniRender();
  },
  leaveBare() { showShell(); },
});

/* ------------------------------------------------------------- deep link */

const deepAppId = new URLSearchParams(location.search).get('app');

function showShell() {
  $('#boot').hidden = true;
  $('#topbar').hidden = false;
  $('#chat').hidden = false;
  $('#composer').hidden = false;
  renderChat();
  renderDrawer();
}

if (deepAppId) {
  const app = getApp(deepAppId);
  if (app) { $('#boot').hidden = true; openApp(app, { bare:true }); resetHistory(); }
  else { history.replaceState(null, '', location.pathname); showShell(); }
} else {
  showShell();
}

/* --------------------------------------------------------------- screens */

function showApps(on) {
  $('#apps-screen').hidden = !on;
  if (on) { renderApps(); push(); }
}

/**
 * Android's back button should close what is on top, not leave the app.
 * The history budget itself lives in ui/dom.js; this decides what a pop means.
 */
addEventListener('popstate', () => {
  if (!notePop()) return;
  if (sheetOpen()) return closeSheet(true);
  if (!$('#player').hidden)      return closeApp();
  if (!$('#apps-screen').hidden) { $('#apps-screen').hidden = true; return; }
  if (!$('#drawer').hidden)      return closeDrawer();
});

/* ---------------------------------------------------------------- wiring */

/* Buttons close their own overlay and then unwind its history entry; a real
   back press goes the other way, through popstate. */
$('#btn-menu').onclick = () => { openDrawer(); push(); };
$('#scrim').onclick = () => { closeDrawer(); back(); };
$('#btn-new-chat').onclick = () => { closeDrawer(); back(); startNewChat(); };
$('#btn-settings').onclick = () => openSettings(() => window.__miniRender());
$('#btn-apps').onclick = () => showApps(true);
$('#btn-apps-back').onclick = () => { $('#apps-screen').hidden = true; back(); };
$('#btn-role').onclick = () => openRolePicker(activeChat(), () => window.__miniRender());
$('#sheet-scrim').onclick = () => closeSheet();
$('#btn-player-close').onclick = () => { closeApp(); back(); };

$('#composer').addEventListener('submit', e => { e.preventDefault(); send(); });
$('#btn-stop').onclick = () => stop();
$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', e => { attachFiles(e.target.files); e.target.value = ''; });

const input = $('#input');
const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 260) + 'px'; };
input.addEventListener('input', grow);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); }
});

/* paste an image straight into the composer */
addEventListener('paste', async e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) { try { addPending(await readImage(f)); } catch {} }
});

/* drop shadow under the bar once the conversation scrolls */
addEventListener('scroll', () => {
  $('#topbar').classList.toggle('scrolled', scrollY > 4);
}, { passive:true });

/* ------------------------------------------------------- install prompt */

addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  window.__miniInstallPrompt = e;
});

if (!standalone && !deepAppId && !state.settings.installDismissed) {
  setTimeout(() => {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
    openSheet(close => [
      el('div', { class:'center', style:{ padding:'6px 0 14px' } },
        el('img', { src:'assets/icon-180.png', width:'72', height:'72', style:{ borderRadius:'20px' } })),
      el('h3', { class:'center', text:t('install') }),
      el('p', { class:'note', text:t('installSub') }),
      el('div', { class:'btn-row' },
        el('button', { class:'btn', text:t('later'), onClick:() => {
          state.settings.installDismissed = true; save(true); close();
        }}),
        el('button', { class:'btn primary', text:t('install'), onClick:async () => {
          const p = window.__miniInstallPrompt;
          if (p) { p.prompt(); await p.userChoice.catch(() => {}); window.__miniInstallPrompt = null; close(); }
          else {
            close();
            openSheet(() => [
              el('h3', { text:t('install') }),
              el('div', { class:'note', html: ios
                ? `Safari'da pastdagi <b>Ulashish</b> tugmasini bosing → <b>«Bosh ekranga qo'shish»</b>.`
                : `Brauzer menyusidan <b>«Ilovani o'rnatish»</b> ni tanlang.` }),
            ]);
          }
          state.settings.installDismissed = true; save(true);
        }})),
    ]);
  }, 900);
}

/* --------------------------------------------------------- service worker */

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
