/**
 * In-process TTL + LRU cache.
 *
 * Used for project summaries, repository metadata, model catalogues and
 * deterministic AI results. Keys are always tenant-scoped by the caller —
 * `cacheKey()` makes that the path of least resistance.
 */

export class TtlCache {
  constructor({ max = 500, ttlMs = 60_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) { this.misses += 1; return undefined; }
    if (entry.expires <= Date.now()) { this.map.delete(key); this.misses += 1; return undefined; }
    // Refresh recency for LRU eviction.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + (ttlMs ?? this.ttlMs) });
    return value;
  }

  /** Read-through helper; concurrent callers share one in-flight promise. */
  async wrap(key, loader, ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = loader();
    this.set(key, pending, ttlMs);
    try {
      const value = await pending;
      this.set(key, value, ttlMs);
      return value;
    } catch (error) {
      this.map.delete(key);
      throw error;
    }
  }

  delete(key) { return this.map.delete(key); }

  /** Invalidate every key beginning with a prefix (e.g. one project). */
  invalidatePrefix(prefix) {
    let removed = 0;
    for (const key of this.map.keys()) if (key.startsWith(prefix)) { this.map.delete(key); removed += 1; }
    return removed;
  }

  clear() { this.map.clear(); }

  stats() {
    const total = this.hits + this.misses;
    return { size: this.map.size, max: this.max, hits: this.hits, misses: this.misses, hitRate: total ? +(this.hits / total).toFixed(3) : 0 };
  }
}

/** Tenant isolation is structural: every cache key starts with the scope. */
export function cacheKey(scope, ...parts) {
  if (!scope) throw new Error('cacheKey requires a tenant scope');
  return [scope, ...parts.map(p => String(p))].join(':');
}

export const caches = {
  models: new TtlCache({ max: 40, ttlMs: 60_000 }),
  settings: new TtlCache({ max: 40, ttlMs: 30_000 }),
  index: new TtlCache({ max: 200, ttlMs: 10 * 60_000 }),
  summaries: new TtlCache({ max: 1000, ttlMs: 30 * 60_000 }),
  completions: new TtlCache({ max: 300, ttlMs: 15 * 60_000 }),
  plans: new TtlCache({ max: 20, ttlMs: 60_000 })
};

export default TtlCache;
