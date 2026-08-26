/**
 * Presence and device tracking.
 *
 * Records which devices are signed in, so the security page shows real
 * sessions a user can revoke, and keeps `last_seen_at` current so "active
 * users" in the admin dashboard means something.
 *
 * Writes are throttled per session — recording every request would be a write
 * amplification of several orders of magnitude for no extra information.
 */

import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { fingerprint } from '../../core/crypto.js';
import { TtlCache } from '../../core/cache.js';
import { logger } from '../../core/logger.js';

const THROTTLE_MS = 5 * 60_000;
const seen = new Map();   // sessionHash -> last write time

/** A readable device name from a user agent string. */
export function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';

  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari' :
    /curl|wget|node|python/i.test(ua) ? 'API client' : 'Browser';

  const platform =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Android/.test(ua) ? 'Android' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Linux/.test(ua) ? 'Linux' : '';

  return platform ? `${browser} on ${platform}` : browser;
}

/**
 * Record that a user is active on a device.
 * Never throws into the request that triggered it.
 *
 * @param {{userId:string, accessToken:string, ip?:string, userAgent?:string}} context
 */
export function touch({ userId, accessToken, ip, userAgent }) {
  if (!userId || !accessToken || !hasServiceRole()) return;

  // The token itself is never stored — only a hash, so the session list cannot
  // be turned into a set of usable credentials.
  const sessionHash = fingerprint(accessToken);
  const now = Date.now();
  const last = seen.get(sessionHash);
  if (last && now - last < THROTTLE_MS) return;
  seen.set(sessionHash, now);

  if (seen.size > 5000) {
    for (const [hash, at] of seen) if (now - at > 3_600_000) seen.delete(hash);
  }

  const timestamp = new Date().toISOString();
  const client = serviceClient();

  // Fire and forget: presence is never worth delaying or failing a request for.
  Promise.all([
    client.insert('user_sessions', {
      user_id: userId,
      session_hash: sessionHash,
      ip: ip && /^[0-9a-f.:]+$/i.test(ip) ? ip : null,
      user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
      device: describeDevice(userAgent),
      last_active_at: timestamp,
      revoked_at: null
    }, { upsert: true, onConflict: 'user_id,session_hash', returning: false }),

    client.from('profiles').eq('id', userId).update({ last_seen_at: timestamp })
  ]).catch(error => logger.debug('presence not recorded', { reason: error?.message }));
}

/**
 * Has this session been revoked from the security page?
 *
 * Checked on every authenticated request, so the answer is cached for 30
 * seconds: a revocation takes effect within half a minute, and the common case
 * costs nothing. Revoking clears the entry so it takes effect immediately.
 */
const revocations = new TtlCache({ max: 5000, ttlMs: 30_000 });

export async function isRevoked(userId, accessToken) {
  if (!hasServiceRole()) return false;
  const hash = fingerprint(accessToken);

  return revocations.wrap(`${userId}:${hash}`, async () => {
    try {
      const row = await serviceClient().from('user_sessions')
        .select('revoked_at').eq('user_id', userId).eq('session_hash', hash).first();
      return Boolean(row?.revoked_at);
    } catch {
      // A lookup failure must not lock a legitimate user out.
      return false;
    }
  });
}

/** Called when a session is revoked, so the change is not delayed by the cache. */
export function forget(userId, accessToken) {
  const hash = accessToken ? fingerprint(accessToken) : null;
  if (hash) { seen.delete(hash); revocations.delete(`${userId}:${hash}`); }
  else revocations.invalidatePrefix(`${userId}:`);
}

export { THROTTLE_MS };
