/**
 * Accounts.
 *
 * A username, a password and a name — nothing else is asked for, because
 * nothing else is needed and every extra field is something to lose. There is
 * no email, so there is no password reset and no way to reach a person: the
 * account is the credential, and losing it loses the account. That is stated
 * plainly in the interface rather than pretended away.
 *
 * Sessions are stateless. A token is `userId.issuedAt.hmac`, verified with a
 * server secret and nothing else, so reading the market costs no lookup and no
 * write. The one thing that must be recorded — when someone was last seen — is
 * written at most once a day per person, which is all the precision a
 * thirty-day inactivity rule needs.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson, debouncedWriter } from './store.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const TOKEN_DAYS = 30;
const DAY = 86_400_000;
const REGS_PER_HOUR = Number(process.env.MINI_REGS_PER_HOUR || 10);

const WEAK = new Set(['123456', '12345678', '123456789', 'password', 'parol', 'qwerty',
  'qwerty123', '111111', '000000', 'iloveyou', 'admin1', 'abc123', 'password1']);

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export class Auth {
  constructor(dataDir, { inactiveDays = 30, secret = '' } = {}) {
    this.file = path.join(dataDir, 'users.json');
    this.inactiveDays = inactiveDays;
    this.users = readJson(this.file, []);
    this.byName = new Map(this.users.map(u => [u.username, u]));
    this.byId = new Map(this.users.map(u => [u.id, u]));
    this.writer = debouncedWriter(this.file, () => this.users);
    this.attempts = new Map();                  // ip -> { n, until }  (bad logins)
    this.regs = new Map();                      // ip -> { hour, n }   (sign-ups)
    this.secret = secret || this.#secretFile(dataDir);
  }

  #secretFile(dataDir) {
    const f = path.join(dataDir, 'secret');
    try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
    const s = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }

  flush() { this.writer.flush(); }

  /* ------------------------------------------------------------ password */

  #hash(password, salt) {
    return crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('base64');
  }

  /** Spends the same work as a real check, so failures cost what successes do. */
  #burn(password) {
    this.#hash(String(password || ''), 'decoy-salt-for-timing');
    return false;
  }

  #verify(user, password) {
    const got = Buffer.from(this.#hash(password, user.salt));
    const want = Buffer.from(user.hash);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  /* -------------------------------------------------------------- tokens */

  /**
   * The password version is inside the signature, so changing a password
   * invalidates every session issued before it — including one an attacker
   * is holding, which is the whole point of changing it.
   */
  #sign(id, at, pv) {
    return crypto.createHmac('sha256', this.secret).update(`${id}.${at}.${pv}`).digest('base64url');
  }

  issue(user) {
    const at = Date.now();
    return `${user.id}.${at}.${this.#sign(user.id, at, user.pv || 0)}`;
  }

  /** @returns the user, or null when the token is absent, forged or stale. */
  verify(token) {
    if (typeof token !== 'string') return null;
    const [id, at, sig] = token.split('.');
    if (!id || !at || !sig) return null;
    if (Date.now() - Number(at) > TOKEN_DAYS * DAY) return null;
    const user = this.byId.get(id);
    if (!user || user.banned) return null;
    const want = Buffer.from(this.#sign(id, at, user.pv || 0));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    this.seen(user);
    return user;
  }

  /** Records activity at day resolution — the inactivity rule needs no more. */
  seen(user) {
    const now = Date.now();
    if (now - (user.lastSeen || 0) < DAY) return;
    user.lastSeen = now;
    this.writer.mark();
  }

  /* ------------------------------------------------------------ accounts */

  register({ name, username, password, ip = '' }) {
    const blocked = this.#regThrottle(ip);
    if (blocked) return { error: blocked };

    name = String(name || '').trim().slice(0, 24);
    username = String(username || '').trim().toLowerCase();
    password = String(password || '');

    if (name.length < 2) return { error: 'Enter your name (at least 2 characters)' };
    if (!USERNAME_RE.test(username))
      return { error: 'Username: 3-20 lowercase letters, digits or _' };
    if (this.byName.has(username)) return { error: 'That username is taken' };
    if (password.length < 6) return { error: 'Password must be at least 6 characters' };
    if (WEAK.has(password.toLowerCase())) return { error: 'That password is too common' };

    const salt = crypto.randomBytes(16).toString('base64');
    const user = {
      id: crypto.randomBytes(9).toString('base64url'),
      name, username, salt, hash: this.#hash(password, salt),
      createdAt: Date.now(), lastSeen: Date.now(), pv: 0,
      publishDay: '', publishCount: 0, apps: 0, banned: false,
    };
    this.users.push(user);
    this.byName.set(username, user);
    this.byId.set(user.id, user);
    writeJson(this.file, this.users);          // a new account is worth a sync write
    return { user };
  }

  login({ username, password, ip }) {
    const blocked = this.#throttle(ip);
    if (blocked) return { error: blocked };

    const user = this.byName.get(String(username || '').trim().toLowerCase());
    // Hash something either way: a fast "no such user" is a username oracle.
    const okPass = user ? this.#verify(user, String(password || '')) : this.#burn(password);
    if (!user || user.banned || !okPass) {
      this.#fail(ip);
      return { error: 'Wrong username or password' };
    }
    this.attempts.delete(ip);
    user.lastSeen = Date.now();
    this.writer.mark();
    return { user };
  }

  changePassword(user, { current, next }) {
    if (!this.#verify(user, String(current || ''))) return { error: 'Current password is wrong' };
    if (String(next || '').length < 6) return { error: 'The new password must be at least 6 characters' };
    if (WEAK.has(String(next).toLowerCase())) return { error: 'That password is too common' };
    user.salt = crypto.randomBytes(16).toString('base64');
    user.hash = this.#hash(next, user.salt);
    user.pv = (user.pv || 0) + 1;              // every older session dies here
    writeJson(this.file, this.users);
    return { ok: true };
  }

  remove(id) {
    const i = this.users.findIndex(u => u.id === id);
    if (i < 0) return false;
    this.byName.delete(this.users[i].username);
    this.byId.delete(this.users[i].id);
    this.users.splice(i, 1);
    writeJson(this.file, this.users);
    return true;
  }

  /* ---------------------------------------------------------- throttling */

  #throttle(ip) {
    const a = this.attempts.get(ip);
    if (a && a.until > Date.now())
      return `Too many attempts. Try again in ${Math.ceil((a.until - Date.now()) / 1000)}s.`;
    return null;
  }

  /**
   * Sign-ups are capped per address per hour, on its own counter.
   *
   * Hashing a password is deliberately expensive, so unlimited registration
   * is a free way to burn the CPU. But a mobile carrier puts a whole city
   * behind one address, so this is generous and never escalates — and it
   * stays clear of the login counter, or one new account would lock out
   * everyone else's next typo.
   */
  #regThrottle(ip) {
    const hour = Math.floor(Date.now() / 3600_000);
    const r = this.regs.get(ip);
    const n = r && r.hour === hour ? r.n : 0;
    if (n >= REGS_PER_HOUR) return 'Too many sign-ups from this network. Try again in an hour.';
    this.regs.set(ip, { hour, n: n + 1 });
    if (this.regs.size > 5000) {                // never let the map grow forever
      for (const [k, v] of this.regs) if (v.hour !== hour) this.regs.delete(k);
    }
    return null;
  }

  #fail(ip) {
    const a = this.attempts.get(ip) || { n: 0, until: 0 };
    a.n++;
    if (a.n >= 5) { a.until = Date.now() + Math.min(15 * 60_000, 2 ** (a.n - 5) * 30_000); a.n = 4; }
    this.attempts.set(ip, a);
  }

  /* ------------------------------------------------------------- cleanup */

  /**
   * Removes accounts nobody has opened in `inactiveDays`.
   *
   * Their published apps stay. Someone installed those and they are the
   * market's content now, not the author's private data — deleting them would
   * break other people's home screens to tidy a row in a JSON file.
   */
  sweep() {
    const cutoff = Date.now() - this.inactiveDays * DAY;
    const gone = this.users.filter(u => (u.lastSeen || u.createdAt) < cutoff);
    if (!gone.length) return [];
    for (const u of gone) { this.byName.delete(u.username); this.byId.delete(u.id); }
    this.users = this.users.filter(u => (u.lastSeen || u.createdAt) >= cutoff);
    writeJson(this.file, this.users);
    return gone.map(u => u.id);
  }

  /** How many days of silence are left before an account disappears. */
  daysLeft(user) {
    return Math.max(0, this.inactiveDays -
      Math.floor((Date.now() - (user.lastSeen || user.createdAt)) / DAY));
  }

  publicUser(user) {
    return {
      id: user.id, name: user.name, username: user.username,
      createdAt: user.createdAt, apps: user.apps || 0,
      inactiveDays: this.inactiveDays, daysLeft: this.daysLeft(user),
    };
  }
}
