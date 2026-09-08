/** The chat screen: messages, the composer, and the agent turn it drives. */

import { state, save, activeChat, touch, getRole, getApp, publishApp } from '../store.js';
import { t } from '../i18n.js';
import { md } from '../md.js';
import { Agent } from '../agent.js';
import { openPublish, openSettings } from './sheets.js';
import { $, el, toast, readImage, svg, ICON } from './dom.js';

let agent = null, pending = [];         // pending = attached images for the next send
let onOpenApp = null;                   // injected by main.js

export function initChat(hooks) { onOpenApp = hooks.openApp; }

/* ------------------------------------------------------------- rendering */

export function renderChat() {
  const chat = activeChat();
  const role = getRole(chat.roleId);
  const box = $('#messages');
  box.innerHTML = '';

  $('#chat-title').textContent = chat.title || t('newChat');
  $('#role-emoji').textContent = role.emoji;
  $('#input').placeholder = t('ask');

  if (!chat.messages.length) { box.append(emptyState(chat)); return; }

  for (const m of chat.messages) box.append(bubbleFor(m));
  const card = artifactCard(chat);
  if (card) box.append(card);
  scrollDown(true);
}

function emptyState(chat) {
  const s = state.settings;
  if (!s.apiKey) {
    return el('div', { class:'empty' },
      el('h2', { text:t('noKeyTitle') }),
      el('p', { text:t('noKeySub') }),
      el('div', { class:'chips' },
        el('button', { class:'chip', text:t('addKey'), onClick:() => openSettings(renderChat) })));
  }
  return el('div', { class:'empty' },
    el('h2', { text:t('emptyTitle') }),
    el('p', { text:t('emptySub') }),
    el('div', { class:'chips' }, ...t('ideas').map(idea =>
      el('button', { class:'chip', text:idea, onClick:() => { $('#input').value = idea; send(); } }))));
}

function bubbleFor(m) {
  const wrap = el('div', { class:`msg ${m.role}` });
  if (m.images?.length) {
    wrap.append(el('div', { class:'msg-imgs' }, ...m.images.map(src => el('img', { src }))));
  }
  if (m.steps?.length) wrap.append(stepsList(m.steps));
  if (m.content) {
    wrap.append(el('div', { class:'bubble',
      ...(m.role === 'user' ? { text:m.content } : { html:md(m.content) }) }));
  }
  return wrap;
}

function stepsList(steps) {
  return el('div', { class:'steps' }, ...steps.map(s =>
    el('div', { class:`step ${s.running ? 'run' : s.ok === false ? 'err' : 'done'}` },
      el('span', { class:'dot' }), el('b', { text:s.label }))));
}

/** One card per chat: the thing being built, always reachable at the bottom. */
function artifactCard(chat) {
  const p = chat.project;
  if (!p?.files?.['index.html']) return null;
  const app = chat.appId ? getApp(chat.appId) : null;
  const name = app?.name || 'Ilova';
  const emoji = app?.emoji || '📱';
  const color = app?.color || '#7c8cff';
  const size = Object.values(p.files).reduce((n, v) => n + v.length, 0);

  return el('div', { class:'artifact' },
    el('div', { class:'artifact-head' },
      el('div', { class:'artifact-ico', style:{ background:color }, text:emoji }),
      el('div', { class:'artifact-meta' },
        el('b', { text:name }),
        el('span', { text:`${Object.keys(p.files).join(', ')} · ${Math.round(size/102.4)/10} KB` }))),
    el('div', { class:'artifact-actions' },
      el('button', { class:'btn', text:t('preview'), onClick:() => onOpenApp?.({
        id: chat.appId || 'draft', name, emoji, color, files:p.files, assets:p.assets,
        deviceAccess: app?.deviceAccess }) }),
      el('button', { class:'btn primary', text: app ? t('update') : t('publish'),
        onClick:() => openPublish(p, app, saved => { chat.appId = saved.id; save(); renderChat(); }) })));
}

function scrollDown(instant) {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  });
}

/* ----------------------------------------------------------- attachments */

export function addPending(dataUrl) {
  pending.push(dataUrl);
  renderPending();
}

function renderPending() {
  const box = $('#attachments');
  box.innerHTML = '';
  box.hidden = !pending.length;
  pending.forEach((src, i) => box.append(
    el('div', { class:'thumb' },
      el('img', { src }),
      el('button', { onClick:() => { pending.splice(i, 1); renderPending(); } }, svg(ICON.x)))));
}

export async function attachFiles(files) {
  for (const f of [...files].slice(0, 4)) {
    try { addPending(await readImage(f)); }
    catch { toast(t('error')); }
  }
}

/* -------------------------------------------------------------- sending */

export function stop() { agent?.stop(); }

export async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text && !pending.length) return;

  const s = state.settings;
  if (!s.apiKey) return openSettings(renderChat);
  if (!s.model)  { toast(t('chooseModel')); return openSettings(renderChat); }

  const chat = activeChat();
  const role = getRole(chat.roleId);

  const userMsg = { role:'user', content:text, images:pending.length ? [...pending] : undefined };
  chat.messages.push(userMsg);

  // An attached photo is both something to look at and something to build with:
  // it lands in the project as rasmN.png so the agent can just <img src> it.
  if (pending.length && role.tools) {
    chat.project.assets ||= [];
    for (const data of pending) {
      chat.project.assets.push({ name:`rasm${chat.project.assets.length + 1}.png`, data });
    }
  }
  if (!chat.title) chat.title = (text || 'Rasm').slice(0, 42);
  pending = []; renderPending();
  input.value = ''; input.style.height = 'auto';
  touch(chat);

  const box = $('#messages');
  if (box.querySelector('.empty')) box.innerHTML = '';
  box.querySelector('.artifact')?.remove();
  box.append(bubbleFor(userMsg));

  // Live assistant bubble
  const steps = [];
  const stepsBox = el('div', { class:'steps' });
  const body = el('div', { class:'bubble' });
  const typing = el('div', { class:'typing' }, el('i'), el('i'), el('i'));
  const live = el('div', { class:'msg ai' }, stepsBox, typing, body);
  box.append(live);
  scrollDown(true);
  setBusy(true);

  let raw = '', dirty = false;
  const paint = () => {
    if (!dirty) return;
    dirty = false;
    body.innerHTML = md(raw);
  };
  const timer = setInterval(paint, 90);

  const repaintSteps = () => {
    stepsBox.innerHTML = '';
    for (const st of steps) stepsBox.append(
      el('div', { class:`step ${st.running ? 'run' : st.ok === false ? 'err' : 'done'}` },
        el('span', { class:'dot' }), el('b', { text:st.label })));
  };

  agent = new Agent({
    settings: s,
    onDelta(v) { raw += v; dirty = true; typing.hidden = true; scrollDown(); },
    onStep(st) {
      if (st.replace) {
        const i = steps.findIndex(x => x.kind === st.kind && x.running);
        if (i >= 0) { steps[i] = { ...st, running:false }; repaintSteps(); scrollDown(); return; }
      }
      steps.push(st); repaintSteps(); scrollDown();
    },
    onArtifact() { touch(chat); },
    publish(meta) {
      const app = publishApp({ id: chat.appId, ...meta, files:chat.project.files, assets:chat.project.assets });
      chat.appId = app.id; save();
      return app;
    },
    onUsage(u) {
      chat.usage ||= { in:0, out:0 };
      chat.usage.in  += u.prompt_tokens || 0;
      chat.usage.out += u.completion_tokens || 0;
      state.totals.in  += u.prompt_tokens || 0;
      state.totals.out += u.completion_tokens || 0;
      state.totals.cost += u.cost || 0;
      save();
    },
  });

  let error = null;
  try {
    await agent.run(chat, role);
  } catch (e) {
    if (e.name !== 'AbortError') error = e.message || String(e);
  } finally {
    clearInterval(timer);
    dirty = true; paint();
    typing.remove();
    setBusy(false);
    agent = null;
  }

  if (error) {
    steps.push({ kind:'err', label:`${t('error')}: ${error}`, ok:false });
    repaintSteps();
  }

  chat.messages.push({
    role:'assistant',
    content: raw.trim(),
    steps: steps.filter(st => st.kind !== 'read' && st.kind !== 'list').map(st => ({ kind:st.kind, label:st.label, ok:st.ok })),
  });
  touch(chat);

  const card = artifactCard(chat);
  if (card) box.append(card);
  scrollDown();
}

function setBusy(on) {
  $('#btn-send').hidden = on;
  $('#btn-stop').hidden = !on;
}
