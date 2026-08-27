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
import { getIntegration } from '../projects/github.js';
import { getConnection as supabaseConnection } from '../projects/supabase.js';
import { materialiseWorkspace, snapshotWorkspace } from '../../exec/persistence.js';
import { config } from '../../config/env.js';
import { invalidatePlanUsage } from '../billing/usage.js';
import { TRUST } from '../../agent/permissions.js';

/** Has this user connected GitHub, and can the deployment talk to it at all? */
async function githubConnected(userId) {
  if (!config.github.clientId) return false;
  return Boolean(await getIntegration(userId, 'github').catch(() => null));
}

/** taskId -> { controller, subscribers, buffer, approvedCalls, finished } */
const active = new Map();

const MAX_BUFFER = 300;

export function activeRun(taskId) { return active.get(taskId) ?? null; }

/**
 * Is this task still executing?
 *
 * A finished run stays in `active` briefly so a late subscriber still receives
 * the end of the timeline. That is not the same as still running, and callers
 * guarding a destructive action must ask this rather than `activeRun`.
 */
export function isRunning(taskId) {
  const run = active.get(taskId);
  return Boolean(run && !run.finished);
}

export function activeCount() {
  let running = 0;
  for (const run of active.values()) if (!run.finished) running += 1;
  return running;
}

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
export async function startTask(task, { project, auth, trust, allowedTiers, preferredModelId, autoTest, confirmPlan, approvedCalls = new Set() }) {
  if (active.has(task.id)) throw conflict('This task is already running');

  const controller = new AbortController();
  const run = { controller, subscribers: new Set(), buffer: [], approvedCalls, finished: false, startedAt: Date.now() };
  active.set(task.id, run);

  const emit = emitter(task.id);

  // A tool that can only ever return "connect your account first" is worse
  // than no tool: it costs schema tokens on every call and invites the model
  // to try. So the GitHub tools are offered only to a user who has connected.
  const [featureFlags, hasGitHub, hasSupabase] = await Promise.all([
    allFeatureFlags(auth.org.id).catch(() => ({})),
    githubConnected(auth.user.id),
    supabaseConnection(auth.user.id).then(Boolean).catch(() => false),
    // The container may be newer than the project. Rebuild the workspace from
    // durable storage before the first tool call rather than letting the agent
    // discover an empty directory and conclude the project is empty.
    project ? materialiseWorkspace(project.id).catch(() => null) : null
  ]);

  const promise = runTask(task, {
    project, auth, emit, signal: controller.signal, approvedCalls,
    trust, allowedTiers, preferredModelId, autoTest, confirmPlan, featureFlags, hasGitHub, hasSupabase
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
    .finally(async () => {
      // Everything the terminal wrote — a generated file, an npm init, a build
      // that produced source — is only on local disk until now. Tool writes
      // mirror themselves; a subprocess cannot, so the run sweeps up after
      // itself once, at the end, rather than on every command.
      if (project) {
        await snapshotWorkspace(project.id).catch(error =>
          logger.warn('post-run snapshot failed', { projectId: project.id, reason: error?.message }));
      }

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

/**
 * Approve a paused tool call and continue the run.
 *
 * This used to start the task over. Everything the run had done — the
 * conversation, the tool groups it had paid to load, the results it had
 * already gathered — was thrown away, and the user paid for all of it a second
 * time to get back to the call they had just approved. The run now writes its
 * state down when it pauses, so approving continues from the pending call
 * rather than from the beginning.
 *
 * The row is re-read rather than trusted: the caller's copy was loaded before
 * the pause was written, so it has no `run_state` on it.
 */
export async function approveAndResume(task, callId, options) {
  const approved = new Set([callId]);
  const current = hasServiceRole()
    ? await serviceClient().from('tasks').select('*').eq('id', task.id).first().catch(() => null)
    : null;

  await updateTask(task.id, { status: 'running', approval: null });
  return startTask({ ...task, ...(current || {}), status: 'running', approval: null }, {
    ...options,
    approvedCalls: approved
  });
}

/**
 * The plan was shown, and the person said go.
 *
 * From here the run carries on to the end without stopping for each edit —
 * that is what confirming a plan means, and asking again for every file would
 * make the confirmation worthless. Trust is raised for this run only, and only
 * to `autonomous`: destructive and outward-facing actions still stop, because
 * "yes, build it" is not the same sentence as "yes, drop the table".
 */
export async function approvePlanAndResume(task, options) {
  const current = hasServiceRole()
    ? await serviceClient().from('tasks').select('*').eq('id', task.id).first().catch(() => null)
    : null;

  const stored = current?.run_state && typeof current.run_state === 'object' ? current.run_state : {};
  const runState = { ...stored, version: 1, planApproved: true };

  await updateTask(task.id, { status: 'running', approval: null, run_state: runState });

  return startTask(
    { ...task, ...(current || {}), status: 'running', approval: null, run_state: runState },
    { ...options, trust: TRUST.AUTONOMOUS, confirmPlan: false }
  );
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
