/**
 * Task execution and live streaming.
 *
 * A running task has an entry in `active`, which holds its AbortController and
 * a fan-out list of subscribers. That is what makes Stop work instantly and
 * lets a browser reconnect to a run already in progress.
 */

import { runTask } from '../../agent/orchestrator.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { logger } from '../../core/logger.js';
import { notFound, conflict } from '../../core/errors.js';
import { notify } from '../notifications/routes.js';
import { registerHandler } from '../../queue/worker.js';
import { enqueue, QUEUES } from '../../queue/queue.js';
import { allFeatureFlags } from '../../ai/catalog.js';
import { invalidatePlanUsage } from '../billing/usage.js';

/** taskId -> { controller, subscribers, buffer, approvedCalls, finished } */
const active = new Map();

const MAX_BUFFER = 300;

export function activeRun(taskId) { return active.get(taskId) ?? null; }
export function activeCount() { return active.size; }

/**
 * Subscribe to a run's events. Replays what has happened so far, so a client
 * that connects late — or reconnects — does not lose the timeline.
 */
export function subscribe(taskId, listener) {
  const run = active.get(taskId);
  if (!run) return null;
  for (const event of run.buffer) listener(event.type, event.data);
  run.subscribers.add(listener);
  return () => run.subscribers.delete(listener);
}

function emitter(taskId) {
  return (type, data) => {
    const run = active.get(taskId);
    if (!run) return;
    const event = { type, data, at: Date.now() };
    run.buffer.push(event);
    if (run.buffer.length > MAX_BUFFER) run.buffer.shift();
    for (const listener of run.subscribers) {
      try { listener(type, data); } catch { /* a dead subscriber must not stop the run */ }
    }
  };
}

/**
 * Start a task.
 * @returns {Promise<object>} the run result
 */
export async function startTask(task, { project, auth, trust, allowedTiers, preferredModelId, autoTest, approvedCalls = new Set() }) {
  if (active.has(task.id)) throw conflict('This task is already running');

  const controller = new AbortController();
  const run = { controller, subscribers: new Set(), buffer: [], approvedCalls, finished: false, startedAt: Date.now() };
  active.set(task.id, run);

  const emit = emitter(task.id);
  const featureFlags = await allFeatureFlags(auth.org.id).catch(() => ({}));

  const promise = runTask(task, {
    project, auth, emit, signal: controller.signal, approvedCalls,
    trust, allowedTiers, preferredModelId, autoTest, featureFlags
  })
    .then(async result => {
      run.finished = true;
      emit('finished', { status: result.status });
      await afterRun(task, result, auth);
      return result;
    })
    .catch(async error => {
      run.finished = true;
      logger.error('task run crashed', { taskId: task.id, reason: error?.message });
      emit('error', { message: error?.message || 'The task failed unexpectedly' });
      return { status: 'failed', summary: error?.message };
    })
    .finally(() => {
      // Keep the buffer around briefly so a late subscriber still sees the end.
      setTimeout(() => active.delete(task.id), 30_000).unref?.();
      invalidatePlanUsage(auth.org.id);
    });

  run.promise = promise;
  return promise;
}

/** Stop a running task immediately. */
export function stopTask(taskId) {
  const run = active.get(taskId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/** Approve a paused tool call and resume the task. */
export async function approveAndResume(task, callId, options) {
  const approved = new Set([callId]);
  await updateTask(task.id, { status: 'running', approval: null });
  return startTask({ ...task, status: 'running' }, { ...options, approvedCalls: approved });
}

async function afterRun(task, result, auth) {
  const succeeded = result.status === 'completed';
  const changed = result.changedFiles?.length ?? 0;

  await notify({
    userId: task.user_id,
    orgId: task.org_id,
    kind: succeeded ? 'task_completed' : result.status === 'waiting_for_approval' ? 'approval_required' : 'task_failed',
    severity: succeeded ? 'success' : result.status === 'failed' ? 'critical' : 'info',
    title: succeeded
      ? `Task completed: ${task.title}`
      : result.status === 'waiting_for_approval'
        ? `Approval needed: ${task.title}`
        : `Task ${result.status}: ${task.title}`,
    body: succeeded && changed ? `${changed} file${changed === 1 ? '' : 's'} changed.` : String(result.summary || '').slice(0, 200),
    link: `/app/tasks/${task.id}`
  });

  // A completed task that changed files means the index is out of date.
  if (succeeded && changed && task.project_id && hasServiceRole()) {
    await enqueue({
      kind: 'project.index', queue: QUEUES.index, priority: 60,
      payload: { projectId: task.project_id, full: false },
      orgId: task.org_id, projectId: task.project_id
    }).catch(() => {});
  }
}

async function updateTask(taskId, patch) {
  if (!hasServiceRole()) return;
  await serviceClient().from('tasks').eq('id', taskId).update(patch).catch(() => {});
}

// ─── background execution ───────────────────────────────────────────────────

/**
 * Background agent runs go through the queue, so a long autopilot task survives
 * the browser closing and does not hold an HTTP connection open.
 */
registerHandler('agent.run', async ({ taskId, trust, allowedTiers, preferredModelId, autoTest }) => {
  const client = serviceClient();
  const task = await client.from('tasks').select('*').eq('id', taskId).first();
  if (!task) throw notFound('Task not found');
  if (['completed', 'failed', 'cancelled'].includes(task.status)) return { skipped: true, status: task.status };

  const [project, profile, membership] = await Promise.all([
    task.project_id ? client.from('projects').select('*').eq('id', task.project_id).first() : null,
    client.from('profiles').select('*').eq('id', task.user_id).first(),
    client.from('organization_members').select('role').eq('org_id', task.org_id).eq('user_id', task.user_id).first()
  ]);

  const auth = {
    user: { id: task.user_id },
    org: { id: task.org_id },
    role: membership?.role || 'member',
    profile,
    db: client
  };

  const result = await startTask(task, {
    project, auth, trust, allowedTiers, preferredModelId, autoTest
  });

  return { status: result.status, changedFiles: result.changedFiles?.length ?? 0 };
});

export async function queueBackgroundRun(task, options) {
  return enqueue({
    kind: 'agent.run',
    queue: QUEUES.agent,
    priority: 20,
    payload: {
      taskId: task.id,
      trust: options.trust,
      allowedTiers: options.allowedTiers,
      preferredModelId: options.preferredModelId,
      autoTest: options.autoTest
    },
    orgId: task.org_id,
    projectId: task.project_id,
    taskId: task.id
  });
}
