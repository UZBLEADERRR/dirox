/**
 * Audit trail and system metrics.
 *
 * Writes go through the service role because an audit record must be written
 * even when the acting user could not read it back, and must not be deletable
 * by that user. Failures here never break the request that triggered them.
 */

import { hasServiceRole, serviceClient } from '../../db/supabase.js';
import { logger } from '../../core/logger.js';
import { redact } from '../../core/logger.js';

const MAX_QUEUE = 200;
let queue = [];
let flushing = false;
let flushTimer = null;

function schedule() {
  if (flushTimer || !queue.length) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, 750);
  flushTimer.unref?.();
}

async function flush() {
  if (flushing || !queue.length) return;
  if (!hasServiceRole()) { queue = []; return; }
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    await serviceClient().insert('audit_logs', batch, { returning: false });
  } catch (error) {
    logger.warn('audit flush failed', { reason: error?.message, dropped: batch.length });
  } finally {
    flushing = false;
    schedule();
  }
}

export const audit = {
  /**
   * Record a security- or billing-relevant action.
   * Buffered and flushed in batches to keep it off the request's critical path.
   */
  record({ orgId = null, actorId = null, actorType = 'user', action, resource = null, resourceId = null, severity = 'info', ip = null, userAgent = null, metadata = {} } = {}) {
    if (!action) return;
    queue.push({
      org_id: orgId,
      actor_id: actorId,
      actor_type: actorType,
      action: String(action).slice(0, 100),
      resource: resource ? String(resource).slice(0, 60) : null,
      resource_id: resourceId ? String(resourceId).slice(0, 100) : null,
      severity,
      ip: ip && /^[0-9a-f.:]+$/i.test(ip) ? ip : null,
      user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
      metadata: redact(metadata)
    });
    if (queue.length >= MAX_QUEUE) flush().catch(() => {});
    else schedule();
  },
  flush
};

/** Latency and error counters for the admin observability page. */
export const metrics = {
  buffer: [],
  observe({ kind, name, status = 'ok', durationMs = 0, orgId = null, metadata = {} }) {
    this.buffer.push({
      kind, name: String(name).slice(0, 120), status, duration_ms: Math.round(durationMs),
      org_id: orgId, metadata: redact(metadata), created_at: new Date().toISOString()
    });
    if (this.buffer.length >= 100) this.flush().catch(() => {});
  },
  async flush() {
    if (!this.buffer.length) return;
    if (!hasServiceRole()) { this.buffer = []; return; }
    const batch = this.buffer;
    this.buffer = [];
    try { await serviceClient().insert('system_events', batch, { returning: false }); }
    catch (error) { logger.warn('metrics flush failed', { reason: error?.message }); }
  }
};

// In-process counters power /api/health without touching the database.
const counters = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0,
  modelCalls: 0,
  modelErrors: 0,
  toolCalls: 0,
  toolErrors: 0,
  agentRuns: 0,
  latencyMs: []
};

export const runtimeStats = {
  request(durationMs, failed) {
    counters.requests += 1;
    if (failed) counters.errors += 1;
    counters.latencyMs.push(durationMs);
    if (counters.latencyMs.length > 500) counters.latencyMs.shift();
  },
  model(failed) { counters.modelCalls += 1; if (failed) counters.modelErrors += 1; },
  tool(failed) { counters.toolCalls += 1; if (failed) counters.toolErrors += 1; },
  agentRun() { counters.agentRuns += 1; },
  snapshot() {
    const sorted = [...counters.latencyMs].sort((a, b) => a - b);
    const at = q => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
    return {
      uptimeSeconds: Math.round((Date.now() - counters.startedAt) / 1000),
      requests: counters.requests,
      errors: counters.errors,
      errorRate: counters.requests ? +(counters.errors / counters.requests).toFixed(4) : 0,
      latency: { p50: at(0.5), p95: at(0.95), p99: at(0.99) },
      model: { calls: counters.modelCalls, errors: counters.modelErrors },
      tools: { calls: counters.toolCalls, errors: counters.toolErrors },
      agentRuns: counters.agentRuns,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576)
    };
  }
};

/** Flush buffers on shutdown so nothing observed is lost. */
export async function drainObservability() {
  await Promise.allSettled([audit.flush(), metrics.flush()]);
}
