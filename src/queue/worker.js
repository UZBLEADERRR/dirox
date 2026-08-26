/**
 * In-process job worker.
 *
 * Handlers register themselves here; the worker polls with backoff so an idle
 * deployment costs almost nothing. Set WORKER_ENABLED=false to run the web
 * service without a worker and scale workers separately.
 */

import { hasServiceRole } from '../db/supabase.js';
import { logger } from '../core/logger.js';
import { QUEUES, claim, complete, fail, reapStale } from './queue.js';

const IDLE_MIN_MS = 1_000;
const IDLE_MAX_MS = 15_000;

const handlers = new Map();
let running = false;
let stopping = false;
let currentJob = null;
const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** @param {string} kind @param {(payload:object, job:object)=>Promise<object>} handler */
export function registerHandler(kind, handler) {
  handlers.set(kind, handler);
}

export function registeredKinds() { return [...handlers.keys()]; }

async function runOnce(queues) {
  const job = await claim(queues, workerId);
  if (!job) return false;

  currentJob = job;
  const handler = handlers.get(job.kind);
  const started = Date.now();

  if (!handler) {
    await fail(job.id, new Error(`No handler registered for job kind "${job.kind}"`), { retry: false });
    currentJob = null;
    return true;
  }

  try {
    const result = await handler(job.payload || {}, job);
    await complete(job.id, result && typeof result === 'object' ? result : {});
    logger.info('job completed', { kind: job.kind, jobId: job.id, durationMs: Date.now() - started });
  } catch (error) {
    const { exhausted } = await fail(job.id, error, { retry: error?.retryable !== false });
    logger.warn('job failed', { kind: job.kind, jobId: job.id, exhausted, reason: error?.message });
  } finally {
    currentJob = null;
  }
  return true;
}

export function startWorker(queues = Object.values(QUEUES)) {
  if (running) return;
  if (!hasServiceRole()) {
    logger.warn('worker not started — SUPABASE_SERVICE_ROLE_KEY is required for background jobs');
    return;
  }
  running = true;
  stopping = false;
  logger.info('worker started', { workerId, queues, kinds: registeredKinds() });

  let idle = IDLE_MIN_MS;
  let reapAt = 0;

  (async function loop() {
    while (!stopping) {
      try {
        if (Date.now() > reapAt) {
          reapAt = Date.now() + 300_000;
          const reaped = await reapStale().catch(() => 0);
          if (reaped) logger.warn('reclaimed stale jobs', { count: reaped });
        }
        const worked = await runOnce(queues);
        idle = worked ? IDLE_MIN_MS : Math.min(IDLE_MAX_MS, Math.round(idle * 1.6));
      } catch (error) {
        logger.error('worker loop error', { reason: error?.message });
        idle = IDLE_MAX_MS;
      }
      if (stopping) break;
      await new Promise(done => { const timer = setTimeout(done, idle); timer.unref?.(); });
    }
    running = false;
  })();
}

export async function stopWorker() {
  if (!running) return;
  stopping = true;
  // Give a job in flight a moment to finish before the process exits.
  const deadline = Date.now() + 10_000;
  while (currentJob && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 200));
  }
  logger.info('worker stopped', { workerId });
}

export function workerStatus() {
  return { running, workerId, kinds: registeredKinds(), currentJob: currentJob ? { id: currentJob.id, kind: currentJob.kind } : null };
}
