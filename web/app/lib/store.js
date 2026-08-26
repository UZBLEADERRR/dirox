/**
 * Observable application state.
 *
 * One store, selector-based subscriptions, no framework. Views subscribe to the
 * slice they render, so a task-progress update does not re-render the sidebar.
 */

const state = {
  ready: false,
  session: null,          // { user, profile, organization, role, isPlatformAdmin }
  organizations: [],
  projects: [],
  project: null,          // active project detail
  conversation: null,
  messages: [],
  task: null,             // active task
  activity: [],           // agent activity timeline for the active task
  notifications: [],
  unreadCount: 0,
  usage: null,
  capabilities: {},
  featureFlags: {},
  ui: {
    theme: 'dark',
    sidebar: 'expanded',   // expanded | collapsed
    drawer: 'closed',
    panel: 'closed',       // closed | open
    panelTab: 'files',
    panelWidth: 400,
    commandPalette: false,
    busy: false
  }
};

const subscribers = new Set();
let notifyQueued = false;

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const entry of subscribers) {
      const next = entry.selector(state);
      if (!shallowEqual(next, entry.last)) {
        entry.last = next;
        try { entry.listener(next, state); } catch (error) { console.error('subscriber failed', error); }
      }
    }
  });
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => Object.is(a[key], b[key]));
}

export const store = {
  get state() { return state; },

  get(path) {
    return path.split('.').reduce((value, key) => (value == null ? value : value[key]), state);
  },

  /** Shallow-merge a patch into the root state. */
  set(patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.is(state[key], value)) { state[key] = value; changed = true; }
    }
    if (changed) notify();
    return state;
  },

  /** Merge into the `ui` slice and mirror durable bits to localStorage. */
  setUi(patch) {
    const next = { ...state.ui, ...patch };
    if (shallowEqual(next, state.ui)) return state.ui;
    state.ui = next;
    persistUi(next);
    notify();
    return next;
  },

  /** @param {(s: typeof state) => any} selector */
  subscribe(selector, listener) {
    const entry = { selector, listener, last: selector(state) };
    subscribers.add(entry);
    return () => subscribers.delete(entry);
  },

  reset() {
    Object.assign(state, {
      ready: true, session: null, organizations: [], projects: [], project: null,
      conversation: null, messages: [], task: null, activity: [],
      notifications: [], unreadCount: 0, usage: null
    });
    notify();
  }
};

const UI_KEY = 'diroxcode.ui';
const PERSISTED = ['theme', 'sidebar', 'panelWidth', 'panelTab'];

function persistUi(ui) {
  try {
    const subset = Object.fromEntries(PERSISTED.map(key => [key, ui[key]]));
    localStorage.setItem(UI_KEY, JSON.stringify(subset));
  } catch { /* private mode or blocked storage: preferences simply do not persist */ }
}

export function restoreUi() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    for (const key of PERSISTED) if (saved[key] !== undefined) state.ui[key] = saved[key];
  } catch { /* ignore */ }
  if (!['dark', 'light'].includes(state.ui.theme)) state.ui.theme = 'dark';
  document.documentElement.dataset.theme = state.ui.theme;
  return state.ui;
}
