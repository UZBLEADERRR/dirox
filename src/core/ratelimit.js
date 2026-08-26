/**
 * Sliding-window rate limiting held in process memory.
 *
 * Deliberately local: a single Railway service instance is the common case, and
 * the durable per-plan quotas (tokens, cost, tasks per day) live in Postgres
 * where they survive restarts. This layer only absorbs bursts.
 */

import { rateLimited } from './errors.js';

export class RateLimiter {
  constructor() { this.buckets = new Map(); this.lastSweep = Date.now(); }

  /** @returns {{allowed:boolean, remaining:number, resetMs:number}} */
  check(key, limit, windowMs) {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) this.sweep(now);
    const bucket = this.buckets.get(key) || [];
    const cutoff = now - windowMs;
    const recent = bucket.filter(ts => ts > cutoff);
    if (recent.length >= limit) {
      this.buckets.set(key, recent);
      return { allowed: false, remaining: 0, resetMs: Math.max(0, recent[0] + windowMs - now) };
    }
    recent.push(now);
    this.buckets.set(key, recent);
    return { allowed: true, remaining: limit - recent.length, resetMs: windowMs };
  }

  consume(key, limit, windowMs, message = 'Too many requests. Please slow down.') {
    const result = this.check(key, limit, windowMs);
    if (!result.allowed) throw rateLimited(message, { retryAfterMs: result.resetMs });
    return result;
  }

  sweep(now = Date.now()) {
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      const recent = bucket.filter(ts => ts > now - 3_600_000);
      if (recent.length) this.buckets.set(key, recent); else this.buckets.delete(key);
    }
  }

  reset(key) { this.buckets.delete(key); }
  size() { return this.buckets.size; }
}

export const limiter = new RateLimiter();

/** Named policies, all overridable per plan by the usage limiter. */
export const POLICIES = {
  auth: { limit: 10, windowMs: 60_000, message: 'Too many authentication attempts. Try again in a minute.' },
  api: { limit: 240, windowMs: 60_000, message: 'Request rate limit reached.' },
  agent: { limit: 20, windowMs: 60_000, message: 'Too many agent runs started. Wait a moment before starting another.' },
  heavy: { limit: 6, windowMs: 60_000, message: 'This operation is rate limited. Try again shortly.' },
  webhook: { limit: 120, windowMs: 60_000, message: 'Webhook rate limit reached.' }
};

export function enforce(policyName, key) {
  const policy = POLICIES[policyName] || POLICIES.api;
  return limiter.consume(`${policyName}:${key}`, policy.limit, policy.windowMs, policy.message);
}

export default limiter;
