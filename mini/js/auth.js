/**
 * The account, from the client's side.
 *
 * A token in localStorage is enough to open the app: the shell never waits on
 * the network to let someone in, because an installed app that will not start
 * when the server hiccups is not an installed app. The server is asked who you
 * are in the background, and only a definite 401 signs you out.
 */

import { marketBase } from './store.js';

const KEY = 'mini.session';

export const session = { token: '', user: null };

try {
  const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (raw?.token) Object.assign(session, raw);
} catch {}

function persist() {
  try {
    session.token
      ? localStorage.setItem(KEY, JSON.stringify(session))
      : localStorage.removeItem(KEY);
  } catch {}
}

export const signedIn = () => !!session.token;
export const authHeaders = () => (session.token ? { Authorization: `Bearer ${session.token}` } : {});

async function call(path, body, method = 'POST') {
  const res = await fetch(marketBase() + '/api/auth/' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function register(fields) {
  const r = await call('register', fields);
  Object.assign(session, r);
  persist();
  return r.user;
}

export async function login(fields) {
  const r = await call('login', fields);
  Object.assign(session, r);
  persist();
  return r.user;
}

export function logout() {
  session.token = '';
  session.user = null;
  persist();
}

/** Refreshes the profile. Signs out only on a definite rejection. */
export async function refresh() {
  if (!session.token) return null;
  try {
    const r = await call('me', null, 'GET');
    session.user = r.user;
    session.quota = r.quota;
    persist();
    return r.user;
  } catch (e) {
    if (/401|kirish kerak/.test(e.message)) { logout(); return null; }
    return session.user;                    // offline, or the server is down
  }
}

export const changePassword = async (fields) => {
  const r = await call('password', fields);
  if (r.token) { session.token = r.token; persist(); }
};

export async function deleteAccount() {
  await call('me', null, 'DELETE');
  logout();
}

/** Wipes everything this browser holds — used when signing out for good. */
export function wipeLocal() {
  for (const k of Object.keys(localStorage)) if (k.startsWith('mini.')) localStorage.removeItem(k);
}

export const displayName = () => session.user?.name || session.user?.username || '';
