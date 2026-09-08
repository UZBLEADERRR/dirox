/**
 * Everything lives in this browser. No account, no server, no sync.
 *
 * One localStorage key holds the whole state so a write is atomic: a half
 * saved chat is worse than a lost one. Writes are debounced because streaming
 * a reply touches state on every token, and localStorage is synchronous.
 */

const KEY = 'mini.v1';
const APPDATA = 'mini.appdata.';   // per mini-app storage namespace

const DEFAULT_ROLES = [
  { id:'chat',    emoji:'💬', builtin:true, tools:false,
    name:{uz:'Suhbat',en:'Chat',ru:'Чат'},
    prompt:'Sen foydali, qisqa javob beradigan yordamchisan. Foydalanuvchi tilida javob ber.' },
  { id:'builder', emoji:'🧩', builtin:true, tools:true,
    name:{uz:'Ilova yasovchi',en:'App builder',ru:'Конструктор'},
    prompt:'' },
  { id:'design',  emoji:'🎨', builtin:true, tools:true,
    name:{uz:'Dizayner',en:'Designer',ru:'Дизайнер'},
    prompt:'Sen dizaynerisan. Interfeys, rang, tipografika va bo\'shliqqa alohida e\'tibor ber. Kam element, ko\'p havo, bitta urg\'u rangi.' },
  { id:'coder',   emoji:'⚡', builtin:true, tools:true,
    name:{uz:'Dasturchi',en:'Coder',ru:'Программист'},
    prompt:'Sen tajribali dasturchisan. Toza, sodda, ishlaydigan kod yoz. Ortiqcha izohsiz.' },
  { id:'writer',  emoji:'✍️', builtin:true, tools:false,
    name:{uz:'Matn',en:'Writer',ru:'Текст'},
    prompt:'Sen matn muharririsan. Aniq, jonli va qisqa yoz.' },
];

const DEFAULTS = {
  v: 1,
  settings: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: '',
    modelName: '',
    lang: '',                 // '' = auto-detect from navigator
    theme: 'system',
    temperature: 0.7,
    historyLimit: 24,         // messages kept in the request window
    maxSteps: 14,             // agent tool-loop budget
    installDismissed: false,
  },
  roles: [],                  // user-made roles only; builtins are merged in
  chats: [],
  apps: [],
  activeChatId: null,
  totals: { in:0, out:0, cost:0 },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(DEFAULTS), ...parsed,
             settings: { ...DEFAULTS.settings, ...(parsed.settings||{}) },
             totals: { ...DEFAULTS.totals, ...(parsed.totals||{}) } };
  } catch { return structuredClone(DEFAULTS); }
}

export const state = load();

let timer = null, failed = false;
export function save(immediate = false) {
  if (timer) clearTimeout(timer);
  const write = () => {
    timer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      failed = false;
    } catch (e) {
      if (!failed) { failed = true; onQuota?.(e); }
    }
  };
  immediate ? write() : (timer = setTimeout(write, 400));
}
export let onQuota = null;
export function setQuotaHandler(fn) { onQuota = fn; }

/* ---------------- roles ---------------- */

export function allRoles() { return [...DEFAULT_ROLES, ...state.roles]; }
export function getRole(id) { return allRoles().find(r => r.id === id) || DEFAULT_ROLES[1]; }

/* ---------------- chats ---------------- */

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function newChat(roleId = 'builder') {
  const chat = {
    id: uid(), title: '', roleId, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [],                     // {role, content, images?, steps?, artifact?}
    project: { files: {}, assets: [] },
    appId: null,
    usage: { in:0, out:0 },
  };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  save();
  return chat;
}

export function activeChat() {
  let c = state.chats.find(x => x.id === state.activeChatId);
  if (!c) c = state.chats[0] || newChat();
  state.activeChatId = c.id;
  if (!c.project) c.project = { files:{}, assets:[] };
  return c;
}

export function deleteChat(id) {
  const i = state.chats.findIndex(c => c.id === id);
  if (i < 0) return;
  state.chats.splice(i, 1);
  if (state.activeChatId === id) state.activeChatId = state.chats[0]?.id || null;
  save();
}

export function touch(chat) { chat.updatedAt = Date.now(); save(); }

/* ---------------- apps ---------------- */

export function publishApp({ id, name, emoji, color, files, assets, deviceAccess }) {
  let app = id ? state.apps.find(a => a.id === id) : null;
  if (!app) {
    app = { id: id || uid(), createdAt: Date.now() };
    state.apps.unshift(app);
  }
  Object.assign(app, {
    name, emoji, color,
    files: structuredClone(files),
    assets: structuredClone(assets || []),
    deviceAccess: !!deviceAccess,
    updatedAt: Date.now(),
  });
  save(true);
  return app;
}

export function getApp(id) { return state.apps.find(a => a.id === id); }

export function deleteApp(id) {
  const i = state.apps.findIndex(a => a.id === id);
  if (i < 0) return;
  state.apps.splice(i, 1);
  try { localStorage.removeItem(APPDATA + id); } catch {}
  save(true);
}

/* mini-app private storage (the sandbox has no localStorage of its own) */
export function appData(appId) {
  try { return JSON.parse(localStorage.getItem(APPDATA + appId) || '{}'); }
  catch { return {}; }
}
export function setAppData(appId, data) {
  try { localStorage.setItem(APPDATA + appId, JSON.stringify(data)); } catch {}
}

/* ---------------- storage meter ---------------- */

export function storageBytes() {
  let n = 0;
  try { for (const k in localStorage) if (k.startsWith('mini.')) n += (localStorage[k] || '').length * 2; }
  catch {}
  return n;
}
