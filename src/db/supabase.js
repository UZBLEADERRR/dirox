/**
 * Supabase access layer.
 *
 * Two distinct clients, and the difference is a security boundary:
 *
 *  - `userClient(accessToken)` forwards the caller's JWT so every query is
 *    filtered by Row Level Security. This is the default for user data.
 *  - `serviceClient()` uses the service role key and bypasses RLS. It is only
 *    for system writes (usage records, audit logs, queue state) and admin
 *    operations that have already passed an explicit admin check.
 *
 * Callers never build URLs by hand — the query builder escapes values so a
 * user-supplied id cannot inject PostgREST filter syntax.
 */

import { config } from '../config/env.js';
import { AppError, notConfigured, upstreamFailed } from '../core/errors.js';
import { logger } from '../core/logger.js';

const REQUEST_TIMEOUT_MS = 15_000;

function requireConfig() {
  if (!config.supabase.url || !config.supabase.anonKey) throw notConfigured('Supabase');
}

/** PostgREST reserves , . ( ) : and " inside filter values. */
function escapeValue(value) {
  const text = String(value ?? '');
  if (/[,.():"\s]/.test(text)) return `"${text.replace(/(["\\])/g, '\\$1')}"`;
  return text;
}

export class QueryBuilder {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.filters = [];
    this.params = new URLSearchParams();
    this.headers = {};
  }

  select(columns = '*') { this.params.set('select', columns); return this; }
  eq(column, value) { this.filters.push([column, `eq.${escapeValue(value)}`]); return this; }
  neq(column, value) { this.filters.push([column, `neq.${escapeValue(value)}`]); return this; }
  gt(column, value) { this.filters.push([column, `gt.${escapeValue(value)}`]); return this; }
  gte(column, value) { this.filters.push([column, `gte.${escapeValue(value)}`]); return this; }
  lt(column, value) { this.filters.push([column, `lt.${escapeValue(value)}`]); return this; }
  lte(column, value) { this.filters.push([column, `lte.${escapeValue(value)}`]); return this; }
  is(column, value) { this.filters.push([column, `is.${value}`]); return this; }
  in(column, values) { this.filters.push([column, `in.(${values.map(escapeValue).join(',')})`]); return this; }
  like(column, pattern) { this.filters.push([column, `ilike.${escapeValue(`%${pattern}%`)}`]); return this; }
  or(expression) { this.params.set('or', `(${expression})`); return this; }
  order(column, { ascending = false, nullsLast = true } = {}) {
    this.params.append('order', `${column}.${ascending ? 'asc' : 'desc'}${nullsLast ? '.nullslast' : ''}`);
    return this;
  }
  limit(n) { this.params.set('limit', String(Math.max(1, Math.min(1000, Number(n) || 50)))); return this; }
  range(from, to) { this.headers.Range = `${from}-${to}`; this.headers['Range-Unit'] = 'items'; return this; }
  count(kind = 'exact') { this.headers.Prefer = [this.headers.Prefer, `count=${kind}`].filter(Boolean).join(','); return this; }

  toQueryString() {
    const params = new URLSearchParams(this.params);
    for (const [column, filter] of this.filters) params.append(column, filter);
    return params.toString();
  }

  async run(method = 'GET', body) {
    const qs = this.toQueryString();
    return this.client.request(`/rest/v1/${this.table}${qs ? `?${qs}` : ''}`, { method, body, headers: this.headers });
  }

  /** Rows array. */
  async all() { const { data } = await this.run('GET'); return Array.isArray(data) ? data : []; }
  /** First row or null. */
  async first() { const rows = await this.limit(1).all(); return rows[0] ?? null; }
  /** First row, or a 404. */
  async one(message = 'Not found') {
    const row = await this.first();
    if (!row) throw new AppError(message, { status: 404, code: 'not_found' });
    return row;
  }
  /** Rows plus the total count from the Content-Range header. */
  async page() {
    const { data, total } = await this.count().run('GET');
    return { rows: Array.isArray(data) ? data : [], total };
  }
  async update(values) {
    this.headers.Prefer = 'return=representation';
    const { data } = await this.run('PATCH', values);
    return Array.isArray(data) ? data : [];
  }
  async remove() {
    this.headers.Prefer = 'return=representation';
    const { data } = await this.run('DELETE');
    return Array.isArray(data) ? data : [];
  }
}

export class SupabaseClient {
  /** @param {{ key:string, accessToken?:string, role:'user'|'service' }} options */
  constructor({ key, accessToken, role }) {
    this.key = key;
    this.accessToken = accessToken;
    this.role = role;
  }

  from(table) { return new QueryBuilder(this, table); }

  async request(path, { method = 'GET', body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    requireConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.supabase.url}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.accessToken || this.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      const text = await response.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }

      if (!response.ok) {
        const message = data?.message || data?.error_description || data?.msg || data?.error || 'Database request failed';
        logger.warn('supabase request failed', { path: path.split('?')[0], status: response.status, role: this.role, code: data?.code });
        throw new AppError(message, {
          status: response.status === 404 ? 404 : response.status >= 500 ? 502 : response.status,
          code: response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'forbidden' : 'database_error',
          retryable: response.status >= 500,
          details: data?.details || null
        });
      }

      const range = response.headers.get('content-range');
      const total = range ? Number(range.split('/')[1]) : undefined;
      return { data, total: Number.isFinite(total) ? total : undefined, status: response.status };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError') throw upstreamFailed('Database request timed out');
      throw upstreamFailed('Could not reach the database', { reason: error?.message });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Insert one or many rows. `upsert` merges on the primary key. */
  async insert(table, values, { upsert = false, returning = true, onConflict } = {}) {
    const prefer = [
      returning ? 'return=representation' : 'return=minimal',
      upsert ? 'resolution=merge-duplicates' : null
    ].filter(Boolean).join(',');
    const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    const { data } = await this.request(`/rest/v1/${table}${query}`, { method: 'POST', body: values, headers: { Prefer: prefer } });
    if (!returning) return null;
    return Array.isArray(data) ? (Array.isArray(values) ? data : data[0] ?? null) : data;
  }

  /** Call a Postgres function. Used for atomic counters and aggregate reads. */
  async rpc(fn, args = {}) {
    const { data } = await this.request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
    return data;
  }
}

export function userClient(accessToken) {
  requireConfig();
  return new SupabaseClient({ key: config.supabase.anonKey, accessToken, role: 'user' });
}

export function anonClient() {
  requireConfig();
  return new SupabaseClient({ key: config.supabase.anonKey, role: 'user' });
}

let serviceSingleton = null;
export function serviceClient() {
  requireConfig();
  if (!config.supabase.serviceKey) throw notConfigured('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceSingleton) serviceSingleton = new SupabaseClient({ key: config.supabase.serviceKey, accessToken: config.supabase.serviceKey, role: 'service' });
  return serviceSingleton;
}

/** True when service-role writes are possible; lets callers degrade quietly. */
export function hasServiceRole() { return Boolean(config.supabase.url && config.supabase.serviceKey); }

export { escapeValue };
