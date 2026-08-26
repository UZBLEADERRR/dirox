/**
 * Durable job queue backed by Postgres.
 *
 * Long work — repository indexing, background agents, test runs, large imports
 * — never blocks an HTTP request. `app.claim_job` uses SELECT ... FOR UPDATE
 * SKIP LOCKED so multiple workers can run safely.
 */

import { hasServiceRole, serviceClient } from '../db/supabase.js';
import { notConfigured } from '../core/errors.js';
import { logger } from '../core/logger.js';

export const QUEUES = {
  index: 'index',      // repository indexing and summarisation
  agent: 'agent',      // background agent runs
  maintenance: 'maintenance' // rollups, cache expiry, stale job reaping
};

export async function enqueue({ kind, queue = QUEUES.index, payload = {}, orgId = null, projectId = null, taskId = null, priority = 100, runAfter = null, maxAttempts = 3 }) {
  if (!hasServiceRole()) throw notConfigured('Background jobs (SUPABASE_SERVICE_ROLE_KEY)');
  const row = await serviceClient().insert('jobs', {
    kind,
    queue,
    payload,
    org_id: orgId,
    project_id: projectId,
    task_id: taskId,
    priority,
    max_attempts: maxAttempts,
    run_after: runAfter ? new Date(runAfter).toISOString() : new Date().toISOString()
  });
  logger.debug('job enqueued', { kind, queue, jobId: row?.id });
  return row;
}

export async function claim(queues, workerId) {
  const rows = await serviceClient().rpc('claim_job', { p_queues: queues, p_worker: workerId });
  return Array.isArray(rows) ? rows[0] ?? null : rows ?? null;
}

export async function complete(jobId, result = {}) {
  await serviceClient().from('jobs').eq('id', jobId).update({
    status: 'completed', result, error: null, locked_at: null, locked_by: null
  });
}

export async function fail(jobId, error, { retry = true, backoffSeconds = 30 } = {}) {
  const client = serviceClient();
  const job = await client.from('jobs').select('attempts,max_attempts').eq('id', jobId).first();
  const exhausted = !retry || !job || job.attempts >= job.max_attempts;
  await client.from('jobs').eq('id', jobId).update({
    status: exhausted ? 'failed' : 'pending',
    error: String(error?.message || error).slice(0, 1000),
    locked_at: null,
    locked_by: null,
    run_after: exhausted ? undefined : new Date(Date.now() + backoffSeconds * 1000).toISOString()
  });
  return { exhausted };
}

export async function cancel(jobId) {
  await serviceClient().from('jobs').eq('id', jobId).in('status', ['pending', 'running']).update({ status: 'cancelled' });
}

export async function reapStale(lockSeconds = 900) {
  const count = await serviceClient().rpc('reap_stale_jobs', { p_lock_seconds: lockSeconds });
  return Number(count) || 0;
}

export async function stats() {
  const client = serviceClient();
  const [pending, running, failed] = await Promise.all([
    client.from('jobs').select('id').eq('status', 'pending').count().run('GET'),
    client.from('jobs').select('id').eq('status', 'running').count().run('GET'),
    client.from('jobs').select('id').eq('status', 'failed').gte('created_at', new Date(Date.now() - 86_400_000).toISOString()).count().run('GET')
  ]);
  return { pending: pending.total ?? 0, running: running.total ?? 0, failed24h: failed.total ?? 0 };
}
