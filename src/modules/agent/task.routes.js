/**
 * Task API: create, watch, approve, stop, inspect and roll back.
 */

import { Router, sendJson, openStream } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, conflict, forbidden, notFound, notConfigured } from '../../core/errors.js';
import { hasServiceRole, serviceClient } from '../../db/supabase.js';
import { audit } from '../observability/audit.js';
import { assertWithinPlan, getPlanUsage } from '../billing/usage.js';
import { defaultBudgetFor } from '../../context/budget.js';
import { classify } from '../../ai/router.js';
import { restoreCheckpoint, compareCheckpoint, createCheckpoint } from '../../agent/checkpoints.js';
import { startTask, stopTask, subscribe, activeRun, isRunning, approveAndResume, queueBackgroundRun } from './runner.js';
import { TRUST } from '../../agent/permissions.js';

const MODES = ['ask', 'edit', 'agent', 'autopilot', 'review', 'debug', 'plan'];

function shapeTask(row) {
  return {
    id: row.id,
    title: row.title,
    objective: row.objective,
    mode: row.mode,
    status: row.status,
    complexity: row.complexity,
    projectId: row.project_id,
    projectName: row.projects?.name ?? null,
    conversationId: row.conversation_id,
    budgetMicros: Number(row.budget_micros),
    costMicros: Number(row.spent_micros || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    iterations: row.iterations,
    plan: row.plan,
    result: row.result,
    changedFiles: row.changed_files,
    approval: row.approval,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    createdAt: row.created_at
  };
}

async function loadTask(ctx, id) {
  const taskId = parse(uuid({ required: true }), id);
  const row = await ctx.auth.db.from('tasks').select('*,projects(id,name,test_command,build_command,dev_command,language,framework,package_manager)')
    .eq('id', taskId).first();
  if (!row) throw notFound('Task not found');
  return row;
}

/** Trust and model preference come from the user's profile, not the request. */
async function runOptions(ctx, project, { modelId = null } = {}) {
  const preferences = ctx.auth.profile?.ai_preferences || {};
  const { plan } = await getPlanUsage(ctx.auth);
  return {
    project,
    auth: ctx.auth,
    trust: Object.values(TRUST).includes(preferences.autonomy) ? preferences.autonomy : TRUST.CONFIRM,
    allowedTiers: plan.allowedModelTiers,
    // A per-request choice beats the saved default. Both are requests, not
    // permissions: the router honours either only for a model an administrator
    // has opened to users.
    preferredModelId: modelId || preferences.defaultModelId || null,
    autoTest: preferences.autoTest !== false
  };
}

export function taskRoutes() {
  const router = new Router();

  router.get('/', async ctx => {
    let query = ctx.auth.db.from('tasks').select('*,projects(id,name)').eq('org_id', ctx.auth.org.id);
    if (ctx.query.projectId) query = query.eq('project_id', parse(uuid({ required: true }), ctx.query.projectId));
    if (ctx.query.status) query = query.eq('status', String(ctx.query.status).slice(0, 30));
    if (ctx.query.mine === 'true') query = query.eq('user_id', ctx.auth.user.id);

    const rows = await query.order('created_at').limit(Math.min(100, Number(ctx.query.limit) || 30)).all();
    return sendJson(ctx.res, 200, { tasks: rows.map(shapeTask) });
  }, { auth: true });

  /**
   * Create and start a task.
   *
   * `background: true` puts it on the queue instead, so a long autopilot run
   * survives the browser closing.
   */
  router.post('/', async ctx => {
    if (!hasServiceRole()) throw notConfigured('The agent (SUPABASE_SERVICE_ROLE_KEY)');

    const body = parse(t.object({
      objective: t.string({ required: true, min: 2, max: 20_000 }),
      projectId: uuid(),
      conversationId: uuid(),
      mode: t.enum(MODES, { default: 'agent' }),
      modelId: uuid(),
      title: t.string({ max: 200, truncate: true }),
      budgetMicros: t.integer({ min: 1000, max: 50_000_000 }),
      background: t.boolean({ default: false })
    }), await ctx.json());

    await assertWithinPlan(ctx.auth, 'task');
    await assertWithinPlan(ctx.auth, 'agent');

    let project = null;
    if (body.projectId) {
      project = await ctx.auth.db.from('projects').select('*').eq('id', body.projectId).first();
      if (!project) throw notFound('Project not found');
      if (project.index_status === 'running') {
        throw conflict('This project is still being indexed. Give it a moment and try again.');
      }
    }

    const classification = classify({ text: body.objective, mode: body.mode });
    const budgetMicros = body.budgetMicros
      ?? ctx.auth.profile?.ai_preferences?.budgetMicros
      ?? await defaultBudgetFor(classification.level);

    const task = await ctx.auth.db.insert('tasks', {
      org_id: ctx.auth.org.id,
      project_id: body.projectId ?? null,
      conversation_id: body.conversationId ?? null,
      user_id: ctx.auth.user.id,
      title: body.title || deriveTitle(body.objective),
      objective: body.objective,
      mode: body.mode,
      status: 'queued',
      complexity: classification.level,
      budget_micros: budgetMicros
    });

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'task.created',
      resource: 'task', resourceId: task.id, metadata: { mode: body.mode, projectId: body.projectId }
    });

    const options = await runOptions(ctx, project, { modelId: body.modelId });

    if (body.background) {
      await queueBackgroundRun(task, options);
      return sendJson(ctx.res, 202, { task: shapeTask(task), background: true });
    }

    // Fire and forget: the browser follows progress on the event stream.
    startTask(task, options).catch(() => { /* the runner records the failure on the task */ });
    return sendJson(ctx.res, 201, { task: shapeTask(task), streamUrl: `/api/tasks/${task.id}/stream` });
  }, { auth: 'write', rateLimit: 'agent' });

  router.get('/:id', async ctx => {
    const task = await loadTask(ctx, ctx.params.id);
    const [steps, toolCalls, findings] = await Promise.all([
      ctx.auth.db.from('task_steps').select('*').eq('task_id', task.id).order('step_index', { ascending: true }).limit(100).all(),
      ctx.auth.db.from('tool_calls').select('id,tool,arguments,status,duration_ms,created_at').eq('task_id', task.id).order('created_at', { ascending: true }).limit(100).all(),
      ctx.auth.db.from('review_findings').select('*').eq('task_id', task.id).limit(50).all()
    ]);

    return sendJson(ctx.res, 200, {
      task: shapeTask(task),
      running: isRunning(task.id),
      steps: steps.map(step => ({
        index: step.step_index, phase: step.phase, title: step.title, status: step.status,
        summary: step.summary, detail: step.detail, durationMs: step.duration_ms,
        inputTokens: step.input_tokens, outputTokens: step.output_tokens
      })),
      toolCalls: toolCalls.map(call => ({
        id: call.id, tool: call.tool, arguments: call.arguments,
        status: call.status, durationMs: call.duration_ms, createdAt: call.created_at
      })),
      findings
    });
  }, { auth: true });

  /** Live activity stream for a running task. */
  router.get('/:id/stream', async ctx => {
    const task = await loadTask(ctx, ctx.params.id);
    const stream = openStream(ctx.req, ctx.res);

    const unsubscribe = subscribe(task.id, (type, data) => {
      if (stream.closed) return;
      stream.send(type, data);
      if (['finished', 'error', 'cancelled'].includes(type)) {
        setTimeout(() => stream.close(), 250);
      }
    });

    if (!unsubscribe) {
      // Not running: send the final state so the client renders immediately.
      stream.send('state', { status: task.status, result: task.result, changedFiles: task.changed_files });
      stream.send('finished', { status: task.status });
      return stream.close();
    }

    ctx.req.on('close', () => { unsubscribe(); });
  }, { auth: true, rateLimit: false });

  router.post('/:id/stop', async ctx => {
    const task = await loadTask(ctx, ctx.params.id);
    if (task.user_id !== ctx.auth.user.id && !ctx.auth.canAdmin) {
      throw forbidden('Only the person who started this task, or an organization admin, can stop it');
    }

    const stopped = stopTask(task.id);
    if (!stopped) {
      await ctx.auth.db.from('tasks').eq('id', task.id)
        .in('status', ['queued', 'planning', 'running', 'testing', 'waiting_for_approval'])
        .update({ status: 'cancelled', finished_at: new Date().toISOString() });
    }

    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'task.stopped', resourceId: task.id });
    return sendJson(ctx.res, 200, { ok: true, wasRunning: stopped });
  }, { auth: true });

  /** Approve or reject a paused tool call. */
  router.post('/:id/approve', async ctx => {
    const task = await loadTask(ctx, ctx.params.id);
    if (task.status !== 'waiting_for_approval') throw conflict('This task is not waiting for approval');
    if (!task.approval) throw conflict('There is no pending approval on this task');

    const body = parse(t.object({
      approved: t.boolean({ required: true }),
      toolCallId: t.string({ max: 100 })
    }), await ctx.json());

    if (body.toolCallId && body.toolCallId !== task.approval.toolCallId) {
      throw conflict('That approval is no longer the pending one');
    }

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id,
      action: body.approved ? 'task.approved' : 'task.rejected',
      resource: 'tool_call', resourceId: task.approval.toolCallId, severity: 'warning',
      metadata: { tool: task.approval.tool, risk: task.approval.risk }
    });

    if (!body.approved) {
      await ctx.auth.db.from('tasks').eq('id', task.id).update({
        status: 'cancelled', approval: null, finished_at: new Date().toISOString(),
        error: `You declined: ${task.approval.description}`
      });
      return sendJson(ctx.res, 200, { ok: true, resumed: false });
    }

    const project = task.projects
      ? await ctx.auth.db.from('projects').select('*').eq('id', task.project_id).first()
      : null;
    const options = await runOptions(ctx, project);

    approveAndResume(task, task.approval.toolCallId, options).catch(() => {});
    return sendJson(ctx.res, 200, { ok: true, resumed: true, streamUrl: `/api/tasks/${task.id}/stream` });
  }, { auth: 'write' });

  /** Retry a failed task as a new run, keeping the original for comparison. */
  router.post('/:id/retry', async ctx => {
    const original = await loadTask(ctx, ctx.params.id);
    if (!['failed', 'cancelled', 'completed'].includes(original.status)) {
      throw conflict('This task is still running');
    }
    await assertWithinPlan(ctx.auth, 'task');
    await assertWithinPlan(ctx.auth, 'agent');

    const task = await ctx.auth.db.insert('tasks', {
      org_id: ctx.auth.org.id,
      project_id: original.project_id,
      conversation_id: original.conversation_id,
      user_id: ctx.auth.user.id,
      title: original.title,
      objective: original.objective,
      mode: original.mode,
      status: 'queued',
      complexity: original.complexity,
      budget_micros: original.budget_micros
    });

    const project = original.project_id
      ? await ctx.auth.db.from('projects').select('*').eq('id', original.project_id).first()
      : null;
    startTask(task, await runOptions(ctx, project)).catch(() => {});

    return sendJson(ctx.res, 201, { task: shapeTask(task), streamUrl: `/api/tasks/${task.id}/stream` });
  }, { auth: 'write', rateLimit: 'agent' });

  // ─── checkpoints ──────────────────────────────────────────────────────────

  router.get('/:id/checkpoints', async ctx => {
    const task = await loadTask(ctx, ctx.params.id);
    const rows = await ctx.auth.db.from('checkpoints')
      .select('id,label,kind,git_sha,files,size_bytes,restored_at,created_at')
      .eq('task_id', task.id).order('created_at').limit(20).all();

    return sendJson(ctx.res, 200, {
      checkpoints: rows.map(row => ({
        id: row.id, label: row.label, kind: row.kind, gitSha: row.git_sha,
        fileCount: Array.isArray(row.files) ? row.files.length : 0,
        sizeBytes: row.size_bytes, restoredAt: row.restored_at, createdAt: row.created_at
      }))
    });
  }, { auth: true });

  router.post('/:id/checkpoints/:checkpointId/restore', async ctx => {
    const task = await loadTask(ctx, ctx.params.id);
    if (!task.project_id) throw badRequest('This task has no project workspace to restore');
    if (isRunning(task.id)) throw conflict('Stop the task before restoring a checkpoint');

    const checkpointId = parse(uuid({ required: true }), ctx.params.checkpointId);
    const result = await restoreCheckpoint(checkpointId, { projectId: task.project_id });

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'checkpoint.restored',
      resource: 'checkpoint', resourceId: checkpointId, severity: 'warning',
      metadata: { restored: result.restored.length, method: result.method }
    });

    return sendJson(ctx.res, 200, result);
  }, { auth: 'write', rateLimit: 'heavy' });

  router.get('/:id/checkpoints/:checkpointId/compare', async ctx => {
    const task = await loadTask(ctx, ctx.params.id);
    if (!task.project_id) throw badRequest('This task has no project workspace');
    const checkpointId = parse(uuid({ required: true }), ctx.params.checkpointId);
    return sendJson(ctx.res, 200, await compareCheckpoint(checkpointId, { projectId: task.project_id }));
  }, { auth: true });

  return router;
}

/** A readable title from the first sentence of the objective. */
function deriveTitle(objective) {
  const firstSentence = String(objective).split(/[.!?\n]/)[0].trim();
  const title = firstSentence.length > 8 ? firstSentence : String(objective).trim();
  return title.slice(0, 90) + (title.length > 90 ? '…' : '');
}

export { shapeTask, deriveTitle, MODES };
