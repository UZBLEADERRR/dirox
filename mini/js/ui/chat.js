/** The chat screen: messages, the composer, and the agent turn it drives. */

import { state, save, activeChat, touch, getRole, getApp, publishApp } from '../store.js';
import { session } from '../auth.js';
import { t } from '../i18n.js';
import { md } from '../md.js';
import { Agent } from '../agent.js';
import { openPublish, openSettings } from './sheets.js';
import { openPublishToMarket } from './market.js';
import { $, el, toast, readImage, svg, ICON, appIcon } from './dom.js';
import { extractText, ExtractError, EXTRACT_MESSAGES } from '../extract.js';

let agent = null, pending = [];         // pending = attached images for the next send
let onOpenApp = null;                   // injected by main.js

export function initChat(hooks) { onOpenApp = hooks.openApp; }

/* ------------------------------------------------------------- rendering */

export function renderChat() {
  const chat = activeChat();
  const role = getRole(chat.roleId);
  const box = $('#messages');
  box.innerHTML = '';

  renderSource();
  $('#role-emoji').textContent = role.emoji;
  $('#role-name').textContent = role.name;
  $('#input').placeholder = t('ask');

  if (!chat.messages.length) { box.append(emptyState(chat)); return; }

  for (const m of chat.messages) box.append(bubbleFor(m));
  const card = artifactCard(chat);
  if (card) box.append(card);
  scrollDown(true);
}

const canTalk = () => !!(state.settings.apiKey || (state.settings.useFree && session.free));

function emptyState(chat) {
  const s = state.settings;
  if (!canTalk()) {
    return el('div', { class:'empty' },
      el('img', { class:'empty-mark', src:'assets/mark.png', alt:'' }),
      el('h2', { text:t('noKeyTitle') }),
      el('p', { text:t('noKeySub') }),
      el('div', { class:'chips' },
        el('button', { class:'chip primary', text:t('addKey'), onClick:() => openSettings(renderChat) })));
  }
  return el('div', { class:'empty' },
    el('img', { class:'empty-mark', src:'assets/mark.png', alt:'' }),
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
  if (m.role === 'user') {
    if (m.content) wrap.append(el('div', { class:'bubble', text:m.content }));
    return wrap;
  }

  // What the agent said and what it did, in the order it happened — a step
  // that comes after a sentence belongs after it, not above the whole reply.
  if (m.blocks?.length) {
    const stream = el('div', { class:'stream' });
    let run = null;
    for (const b of m.blocks) {
      if (b.t === 'text') {
        run ||= el('div', { class:'bubble' });
        run.innerHTML = md((run.dataset.raw = (run.dataset.raw || '') + b.v));
        if (!run.parentNode) stream.append(run);
      } else {
        run = null;
        stream.append(stepRow(b));
      }
    }
    wrap.append(stream);
    return wrap;
  }

  if (m.steps?.length) wrap.append(stepsList(m.steps));
  if (m.content) wrap.append(el('div', { class:'bubble', html:md(m.content) }));
  return wrap;
}

/* --------------------------------------------------------- live stream */

const WORKING_WORDS = [
  'Diroxing', 'Thinking', 'Wiring things up', 'Drawing', 'Reading the room',
  'Sketching', 'Cooking', 'Measuring twice', 'Tightening bolts', 'Naming things',
  'Checking corners', 'Making it fit', 'Sanding the edges', 'Counting pixels',
];

/** The line that says work is still happening, with a word that keeps moving. */
function statusLine() {
  const word = el('span', { class:'sw', text: WORKING_WORDS[0] });
  const box = el('div', { class:'working' },
    el('span', { class:'dots' }, el('i'), el('i'), el('i')), word);
  let i = 0;
  const timer = setInterval(() => {
    i = (i + 1) % WORKING_WORDS.length;
    word.classList.add('out');
    setTimeout(() => { word.textContent = WORKING_WORDS[i]; word.classList.remove('out'); }, 200);
  }, 2400);
  return { el: box, stop() { clearInterval(timer); box.remove(); } };
}

/**
 * Collects one assistant turn as an ordered list of text runs and step rows,
 * appending each to the page as it arrives.
 */
function liveStream(container) {
  const blocks = [];
  const byId = new Map();
  let run = null, raw = '', dirty = false;

  const paint = () => { if (dirty && run) { dirty = false; run.innerHTML = md(raw); } };
  const timer = setInterval(paint, 90);

  return {
    blocks,
    text(v) {
      if (!run) { raw = ''; run = el('div', { class:'bubble' }); container.append(run); }
      raw += v;
      dirty = true;
      const last = blocks[blocks.length - 1];
      if (last?.t === 'text') last.v += v;
      else blocks.push({ t:'text', v });
    },
    step(st) {
      paint();
      run = null;                                  // the next text starts a new run
      if (st.id != null && byId.has(st.id)) {
        const b = byId.get(st.id);
        Object.assign(b, st, { t:'step', running: st.running ?? false });
        b.el.replaceWith(b.el = stepRow(b));
        return;
      }
      const b = { t:'step', ...st, el: null };
      b.el = stepRow(b);
      container.append(b.el);
      blocks.push(b);
      if (st.id != null) byId.set(st.id, b);
    },
    end() {
      clearInterval(timer);
      paint();
      // The DOM nodes are not worth persisting.
      return blocks.map(b => b.t === 'text'
        ? { t:'text', v:b.v }
        : { t:'step', kind:b.kind, label:b.label, ok:b.ok !== false });
    },
  };
}

function stepsList(steps) {
  return el('div', { class:'steps' }, ...steps.map(stepRow));
}

function stepRow(s) {
  return el('div', { class:`step ${s.running ? 'run' : s.ok === false ? 'err' : 'done'}` },
    el('span', { class:'dot' }),
    el('b', { text:s.label }),
    s.running ? el('span', { class:'shimmer' }) : null);
}

/** One card per chat: the thing being built, always reachable at the bottom. */
function artifactCard(chat) {
  const p = chat.project;
  if (!p?.files?.['index.html']) return null;
  const app = chat.appId ? getApp(chat.appId) : null;
  const name = app?.name || p.course?.title || p.book?.title || 'App';
  const emoji = app?.emoji || (p.course ? '🎓' : p.book ? '📖' : '📱');
  const color = app?.color || '#7c8cff';
  const size = Object.values(p.files).reduce((n, v) => n + v.length, 0);
  const detail = p.course
    ? `${p.course.modules.reduce((n, m) => n + m.lessons.length, 0)} lessons · ${Math.round(size / 102.4) / 10} KB`
    : p.book
    ? `${p.book.chapters.length} chapters · ${Math.round(size / 102.4) / 10} KB`
    : `${Object.keys(p.files).length} files · ${Math.round(size / 102.4) / 10} KB`;

  return el('div', { class:'artifact' },
    el('div', { class:'artifact-head' },
      appIcon({ emoji, color, iconImage: app?.iconImage }, 'artifact-ico'),
      el('div', { class:'artifact-meta' },
        el('b', { text:name }),
        el('span', { text: detail }))),
    el('div', { class:'artifact-actions' },
      el('button', { class:'btn', text:t('preview'), onClick:() => onOpenApp?.({
        id: chat.appId || 'draft', name, emoji, color, files:p.files, assets:p.assets,
        deviceAccess: app?.deviceAccess }) }),
      el('button', { class:'btn primary', text: app ? t('update') : t('publish'),
        onClick:() => openPublish(p, app, saved => { chat.appId = saved.id; save(); renderChat(); }) })),
    app ? el('div', { class:'artifact-actions', style:{ paddingTop:'0' } },
      el('button', { class:'btn dark', text:t('marketPublish'),
        onClick:() => openPublishToMarket(p, { name:app.name, emoji:app.emoji, color:app.color }) })) : null);
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

/**
 * Images become attachments the model can look at; documents become the
 * project's source, which a course or a book can then be built from.
 */
export async function attachFiles(files) {
  for (const f of [...files].slice(0, 4)) {
    if (f.type.startsWith('image/')) {
      try { addPending(await readImage(f)); } catch { toast(t('error')); }
      continue;
    }
    await attachDocument(f);
  }
}

async function attachDocument(file) {
  const chat = activeChat();
  toast(t('reading'));
  try {
    const doc = await extractText(file, { maxChars: 200_000 });
    chat.project.source = { title: doc.title, text: doc.text, kind: doc.kind };
    save();
    renderSource();
    toast(`${doc.title} — ${Math.round(doc.chars / 1000)}k ${t('words')}` +
          (doc.truncated ? `. ${t('sourceTooBig')}` : ''));
  } catch (e) {
    toast(e instanceof ExtractError
      ? (EXTRACT_MESSAGES[e.message] || t('unsupportedFile'))
      : `${t('error')}: ${e.message}`, 4200);
  }
}

/** The uploaded document sits above the composer until it is removed. */
function renderSource() {
  const chat = activeChat();
  const box = $('#source-chip');
  const src = chat.project?.source;
  box.hidden = !src;
  if (!src) return;
  box.innerHTML = '';
  box.append(
    svg(ICON.doc),
    el('b', { text:src.title }),
    el('small', { text:`${Math.round(src.text.length / 1000)}k` }),
    el('button', { 'aria-label':'Remove', onClick:() => {
      delete chat.project.source; save(); renderSource();
    }}, svg(ICON.x)));
}

/* -------------------------------------------------------------- sending */

export function stop() { agent?.stop(); }

export async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text && !pending.length) return;

  const s = state.settings;
  if (!canTalk()) return openSettings(renderChat);
  if (!s.model && !s.useFree) { toast(t('chooseModel')); return openSettings(renderChat); }

  const chat = activeChat();
  const role = getRole(chat.roleId);

  const userMsg = { role:'user', content:text, images:pending.length ? [...pending] : undefined };
  chat.messages.push(userMsg);

  // An attached photo is both something to look at and something to build with:
  // it lands in the project as rasmN.png so the agent can just <img src> it.
  if (pending.length && role.tools) {
    chat.project.assets ||= [];
    for (const data of pending) {
      chat.project.assets.push({ name:`image${chat.project.assets.length + 1}.png`, data });
    }
  }
  if (!chat.title) chat.title = (text || 'Image').slice(0, 42);
  pending = []; renderPending();
  input.value = ''; input.style.height = 'auto';
  touch(chat);

  const box = $('#messages');
  if (box.querySelector('.empty')) box.innerHTML = '';
  box.querySelector('.artifact')?.remove();
  box.append(bubbleFor(userMsg));

  // Live assistant turn: text and steps in the order they actually happen.
  const streamBox = el('div', { class:'stream' });
  const live = el('div', { class:'msg ai' }, streamBox);
  const status = statusLine();
  live.append(status.el);
  box.append(live);
  scrollDown(true);
  setBusy(true);

  const turn = liveStream(streamBox);

  agent = new Agent({
    settings: s,
    onDelta(v) { turn.text(v); scrollDown(); },
    onStep(st) { turn.step(st); scrollDown(); },
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
    status.stop();
    setBusy(false);
    agent = null;
  }

  if (error) turn.step({ kind:'err', label:`${t('error')}: ${error}`, ok:false });

  const blocks = turn.end();
  chat.messages.push({
    role:'assistant',
    content: blocks.filter(b => b.t === 'text').map(b => b.v).join('').trim(),
    blocks,
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
