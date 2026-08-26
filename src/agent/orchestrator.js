/**
 * The agent loop.
 *
 *   classify -> plan -> retrieve -> model -> tools -> observe -> validate -> report
 *
 * Everything that makes this safe rather than merely clever lives here:
 * iteration limits, loop detection, budget pressure, escalation only after a
 * measured failure, and approval gates that pause the run instead of guessing.
 *
 * Progress is emitted as concise, user-safe activity — never raw reasoning.
 */

import { complete } from '../ai/gateway.js';
import { classify, classifierPrompt, parseClassification, route, escalate } from '../ai/router.js';
import { systemSetting } from '../ai/catalog.js';
import { assembleContext } from '../context/engine.js';
import { TokenBudget, defaultBudgetFor } from '../context/budget.js';
import { plannerPrompt } from './prompts.js';
import { toolsFor, toolDefinitions, executeTool } from './tools/index.js';
import { createCheckpoint, captureOriginal } from './checkpoints.js';
import { reviewChange, summariseFindings } from './review.js';
import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { AppError, cancelled, quotaExceeded } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { runtimeStats } from '../modules/observability/audit.js';

const PHASES = {
  CLASSIFY: 'classify', PLAN: 'plan', RETRIEVE: 'retrieve', MODEL: 'model',
  TOOL: 'tool', OBSERVE: 'observe', VALIDATE: 'validate', REVIEW: 'review',
  CHECKPOINT: 'checkpoint', FINALIZE: 'finalize'
};

/**
 * Run one task to completion.
 *
 * @param {object} task    the tasks row
 * @param {object} options { project, auth, emit, signal, approvedCalls, resumeState }
 * @returns {Promise<{status:string, summary:string, changedFiles:Array, budget:object, iterations:number}>}
 */
export async function runTask(task, options) {
  const { project, auth, emit = () => {}, signal, approvedCalls = new Set() } = options;
  const defaults = await systemSetting('agent.defaults', {
    max_iterations: 18, loop_detection_window: 3, escalation_attempts: 2, tool_output_limit: 6000
  });

  const budget = new TokenBudget({
    budgetMicros: Number(task.budget_micros),
    spentMicros: Number(task.spent_micros || 0),
    level: task.complexity || 'level1'
  });

  const state = {
    stepIndex: Number(task.iterations || 0),
    changedFiles: new Map(),
    toolResults: [],
    recentActions: [],
    consecutiveFailures: 0,
    escalations: 0,
    checkpointed: false,
    checkpointId: null,
    conversation: []
  };

  const recordFileChange = (path, kind) => {
    const existing = state.changedFiles.get(path);
    // A file created then modified is still "created" from the user's view.
    state.changedFiles.set(path, existing?.kind === 'created' && kind === 'modified' ? existing : { path, kind });
  };

  /**
   * Called before a tool writes. Folds the file's original contents into the
   * checkpoint so it is genuinely restorable, rather than a checkpoint that
   * promises recovery it cannot deliver.
   */
  const beforeFileChange = async path => {
    if (!state.checkpointId || !project) return;
    await captureOriginal(state.checkpointId, project.id, path).catch(() => {});
  };

  const step = async (phase, title, fn, detail = {}) => {
    state.stepIndex += 1;
    const index = state.stepIndex;
    const started = Date.now();
    emit('step', { index, phase, title, status: 'running' });

    try {
      const result = await fn();
      const durationMs = Date.now() - started;
      const summary = result?.summary ?? title;
      emit('step', { index, phase, title, status: 'completed', summary, durationMs, detail: result?.detail });
      await persistStep(task.id, index, phase, title, 'completed', summary, { ...detail, ...(result?.detail || {}) }, durationMs, result?.usage);
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      const app = error instanceof AppError ? error : new AppError(String(error?.message || error));
      emit('step', { index, phase, title, status: 'failed', summary: app.message, durationMs });
      await persistStep(task.id, index, phase, title, 'failed', app.message, detail, durationMs);
      throw error;
    }
  };

  const abortIfCancelled = () => {
    if (signal?.aborted) throw cancelled('The task was stopped');
  };

  runtimeStats.agentRun();

  try {
    // ── 1. classify ──────────────────────────────────────────────────────────
    let classification = classify({
      text: task.objective,
      mode: task.mode,
      hasError: /error|exception|traceback|stack trace|failing/i.test(task.objective)
    });

    if (classification.confidence < 0.6 && budget.pressure === 'comfortable') {
      // Only pay for a classifier call when the heuristic is genuinely unsure.
      await step(PHASES.CLASSIFY, 'Understanding the request', async () => {
        const cheapRoute = await route({ category: 'classify', level: 'level0', allowedTiers: options.allowedTiers });
        const result = await complete({
          messages: classifierPrompt(task.objective),
          routeResult: cheapRoute,
          temperature: 0,
          maxTokens: 100,
          responseFormat: 'json',
          cache: true,
          signal,
          context: { orgId: auth.org.id, userId: auth.user.id, projectId: project?.id, taskId: task.id }
        });
        budget.record(result.costMicros, 'classify');
        classification = parseClassification(result.text, classification);
        return { summary: `${classification.category} task, complexity ${classification.level.replace('level', 'L')}`, usage: result.usage };
      });
    } else {
      emit('step', {
        index: ++state.stepIndex, phase: PHASES.CLASSIFY,
        title: 'Understanding the request', status: 'completed',
        summary: `${classification.category} task, complexity ${classification.level.replace('level', 'L')}`
      });
    }

    budget.level = classification.level;
    if (!task.budget_micros || Number(task.budget_micros) <= 0) {
      budget.budgetMicros = await defaultBudgetFor(classification.level);
    }

    await updateTask(task.id, {
      complexity: classification.level,
      status: 'planning',
      budget_micros: budget.budgetMicros,
      started_at: task.started_at || new Date().toISOString()
    });

    // ── 2. route ─────────────────────────────────────────────────────────────
    let currentRoute = await route({
      category: classification.category,
      level: classification.level,
      allowedTiers: options.allowedTiers,
      preferredModelId: options.preferredModelId,
      requireTools: task.mode !== 'ask'
    });

    emit('model', { name: currentRoute.model.name, level: currentRoute.level, category: currentRoute.category });
    await updateTask(task.id, { primary_model_id: currentRoute.model.id });

    // ── 3. checkpoint before the first change ────────────────────────────────
    if (project && ['agent', 'autopilot', 'edit', 'debug'].includes(task.mode)) {
      await step(PHASES.CHECKPOINT, 'Creating a restore point', async () => {
        const checkpoint = await createCheckpoint({
          projectId: project.id, taskId: task.id, kind: 'pre_task',
          label: task.title, userId: auth.user.id
        });
        state.checkpointed = Boolean(checkpoint);
        state.checkpointId = checkpoint?.id ?? null;
        return { summary: checkpoint ? 'Restore point created' : 'Restore point unavailable' };
      });
    }

    // ── 4. plan, for anything non-trivial ────────────────────────────────────
    let plan = null;
    if (classification.level !== 'level0' && task.mode !== 'ask') {
      plan = await step(PHASES.PLAN, 'Planning the work', async () => {
        const planRoute = await route({
          category: 'plan',
          level: classification.level === 'level4' ? 'level3' : classification.level,
          allowedTiers: options.allowedTiers
        });
        const limits = await budget.limits({ model: planRoute.model, level: classification.level });
        const context = await assembleContext({
          projectId: project?.id, orgId: auth.org.id, userId: auth.user.id,
          objective: task.objective, mode: 'plan', limits, project,
          availableTools: []
        });

        const result = await complete({
          messages: [...context.messages.filter(m => m.role === 'system'), ...plannerPrompt(task.objective, {
            fileCount: context.retrieval.files.length, mode: task.mode
          })],
          routeResult: planRoute,
          temperature: 0.1,
          maxTokens: Math.min(2000, limits.outputTokens),
          responseFormat: 'json',
          signal,
          context: { orgId: auth.org.id, userId: auth.user.id, projectId: project?.id, taskId: task.id }
        });

        budget.record(result.costMicros, 'plan');
        const parsed = parsePlan(result.text);
        return {
          summary: parsed.steps.length ? `${parsed.steps.length} steps · ${countPlanFiles(parsed)} files affected` : 'Proceeding directly',
          detail: parsed,
          usage: result.usage,
          value: parsed
        };
      }).then(result => result.value);

      if (plan) {
        emit('plan', plan);
        await updateTask(task.id, { plan });
      }
    }

    if (task.mode === 'plan') {
      await updateTask(task.id, {
        status: 'completed', finished_at: new Date().toISOString(),
        spent_micros: budget.spentMicros, iterations: state.stepIndex,
        result: { plan, summary: plan?.summary || 'Plan produced.' }
      });
      return { status: 'completed', summary: plan?.summary || 'Plan produced.', plan, changedFiles: [], budget: budget.toJSON(), iterations: state.stepIndex };
    }

    // ── 5. the loop ──────────────────────────────────────────────────────────
    await updateTask(task.id, { status: 'running' });

    const tools = toolsFor({
      mode: task.mode,
      featureFlags: options.featureFlags || {},
      hasRepository: Boolean(project),
      hasDevCommand: Boolean(project?.dev_command)
    });

    const maxIterations = Math.min(Number(task.max_iterations) || defaults.max_iterations, 40);
    let iteration = 0;
    let finalText = '';
    let pendingApproval = null;

    while (iteration < maxIterations) {
      abortIfCancelled();
      iteration += 1;

      if (budget.exhausted) {
        finalText = finalText || 'The task budget was used up before the work could be finished.';
        emit('notice', { level: 'warning', message: 'Budget exhausted — stopping to avoid further spend.' });
        break;
      }

      const limits = await budget.limits({ model: currentRoute.model, level: classification.level });

      // ── retrieve ──
      const context = await step(PHASES.RETRIEVE, 'Gathering context', async () => {
        const assembled = await assembleContext({
          projectId: project?.id,
          orgId: auth.org.id,
          userId: auth.user.id,
          objective: buildObjective(task, plan, state, iteration),
          mode: task.mode,
          limits,
          history: state.conversation,
          toolResults: state.toolResults.slice(-4),
          taskFiles: [...state.changedFiles.keys()],
          project,
          budget,
          availableTools: tools
        });

        return {
          summary: assembled.retrieval.files.length
            ? `${assembled.retrieval.files.length} files · ${Math.round(assembled.retrieval.contextTokens / 100) / 10}K tokens`
            : 'No repository context needed',
          detail: { files: assembled.retrieval.files.map(f => f.path), tokens: assembled.tokens },
          value: assembled
        };
      }, { iteration }).then(result => result.value);

      emit('context', {
        files: context.retrieval.files.map(file => ({ path: file.path, lines: file.endLine ? `${file.startLine}-${file.endLine}` : null })),
        tokens: context.retrieval.contextTokens,
        truncated: context.retrieval.truncated
      });

      // ── model ──
      abortIfCancelled();
      const affordability = budget.canAfford(currentRoute.model, {
        inputTokens: context.tokens, maxOutputTokens: limits.outputTokens
      });
      if (!affordability.affordable) {
        // Try a cheaper route rather than failing outright.
        const cheaper = await route({ category: classification.category, level: 'level1', allowedTiers: options.allowedTiers, requireTools: true });
        if (cheaper.model.id !== currentRoute.model.id) {
          emit('notice', { level: 'info', message: `Switching to ${cheaper.model.name} to stay within budget.` });
          currentRoute = cheaper;
        } else {
          finalText = finalText || 'The remaining budget is too small to continue safely.';
          break;
        }
      }

      const response = await step(PHASES.MODEL, iteration === 1 ? 'Working on the task' : 'Continuing', async () => {
        const result = await complete({
          messages: context.messages,
          routeResult: currentRoute,
          tools: toolDefinitions(tools),
          maxTokens: limits.outputTokens,
          signal,
          context: { orgId: auth.org.id, userId: auth.user.id, projectId: project?.id, taskId: task.id }
        });
        budget.record(result.costMicros, `model:${iteration}`);
        emit('cost', budget.toJSON());

        return {
          summary: result.toolCalls.length
            ? `${result.toolCalls.length} action${result.toolCalls.length === 1 ? '' : 's'} to take`
            : 'Response ready',
          usage: result.usage,
          value: result
        };
      }, { iteration }).then(result => result.value);

      if (response.text) {
        state.conversation.push({ role: 'assistant', content: response.text });
        finalText = response.text;
      }

      // ── no tool calls: the model considers the task done ──
      if (!response.toolCalls.length) {
        state.consecutiveFailures = 0;
        break;
      }

      // ── tools ──
      state.conversation.push({
        role: 'assistant',
        content: response.text || '',
        tool_calls: response.toolCalls.map(call => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      });

      let anyFailed = false;
      state.toolResults = [];

      for (const call of response.toolCalls.slice(0, 8)) {
        abortIfCancelled();

        // ── loop detection ──
        const signature = `${call.name}:${JSON.stringify(call.arguments).slice(0, 200)}`;
        state.recentActions.push(signature);
        if (state.recentActions.length > 12) state.recentActions.shift();
        const repeats = state.recentActions.filter(action => action === signature).length;

        if (repeats > (defaults.loop_detection_window ?? 3)) {
          emit('notice', { level: 'warning', message: `Stopping: the same action (${call.name}) was repeated ${repeats} times without progress.` });
          finalText = finalText || `I repeated the same action (${call.name}) without making progress, so I stopped rather than continuing to spend budget. The underlying problem may need a different approach.`;
          iteration = maxIterations;
          break;
        }

        emit('tool', { id: call.id, name: call.name, status: 'running', description: describeCall(call) });

        const result = await executeTool(call, {
          projectId: project?.id,
          project,
          userId: auth.user.id,
          taskId: task.id,
          trust: options.trust,
          mode: task.mode,
          role: auth.role,
          signal,
          approvedCalls,
          toolOutputLimit: limits.toolOutputChars,
          recordFileChange,
          beforeFileChange,
          onOutput: chunk => emit('output', { tool: call.name, ...chunk })
        });

        emit('tool', {
          id: call.id, name: call.name, status: result.status,
          summary: firstLine(result.output), description: describeCall(call)
        });

        if (result.status === 'awaiting_approval') {
          pendingApproval = result.approval;
          break;
        }

        state.toolResults.push({ toolCallId: call.id, tool: call.name, output: result.output });
        state.conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result.output });

        if (!result.ok) anyFailed = true;
      }

      if (pendingApproval) break;

      // ── escalate only after a measured failure ──
      state.consecutiveFailures = anyFailed ? state.consecutiveFailures + 1 : 0;
      if (state.consecutiveFailures >= 2 && state.escalations < (defaults.escalation_attempts ?? 2)) {
        const stronger = await escalate(currentRoute, { allowedTiers: options.allowedTiers, attempt: state.escalations + 1 });
        if (stronger) {
          state.escalations += 1;
          state.consecutiveFailures = 0;
          currentRoute = stronger;
          classification.level = stronger.level;
          emit('notice', { level: 'info', message: `Escalating to ${stronger.model.name} after repeated failures.` });
          emit('model', { name: stronger.model.name, level: stronger.level, category: stronger.category, escalated: true });
        }
      }

      // Trim the conversation so it cannot grow without bound.
      if (state.conversation.length > 24) state.conversation = state.conversation.slice(-16);
    }

    // ── 6. approval pause ────────────────────────────────────────────────────
    if (pendingApproval) {
      await updateTask(task.id, {
        status: 'waiting_for_approval',
        approval: pendingApproval,
        spent_micros: budget.spentMicros,
        iterations: state.stepIndex,
        changed_files: [...state.changedFiles.values()]
      });
      emit('approval', pendingApproval);
      return {
        status: 'waiting_for_approval',
        summary: `Waiting for your approval: ${pendingApproval.description}`,
        approval: pendingApproval,
        changedFiles: [...state.changedFiles.values()],
        budget: budget.toJSON(),
        iterations: state.stepIndex
      };
    }

    // ── 7. validate ──────────────────────────────────────────────────────────
    const changedFiles = [...state.changedFiles.values()];
    let validation = null;

    if (changedFiles.length && project?.test_command && options.autoTest !== false && !budget.exhausted) {
      validation = await step(PHASES.VALIDATE, 'Running tests', async () => {
        const result = await executeTool(
          { id: 'validate', name: 'run_tests', arguments: {} },
          {
            projectId: project.id, project, userId: auth.user.id, taskId: task.id,
            trust: options.trust, mode: task.mode, role: auth.role, signal,
            approvedCalls: new Set(['validate']),
            toolOutputLimit: 4000, recordFileChange
          }
        );
        return {
          summary: result.metadata?.summary || (result.ok ? 'Tests passed' : 'Tests failed'),
          detail: { passed: result.ok },
          value: result
        };
      }).then(result => result.value).catch(() => null);

      if (validation && !validation.ok) {
        emit('notice', { level: 'warning', message: 'Tests are failing after the change.' });
      }
    }

    // ── 7b. review ───────────────────────────────────────────────────────────
    let review = null;
    if (changedFiles.length && !budget.exhausted &&
        (task.mode === 'review' || options.autoReview === true) &&
        options.featureFlags?.code_review !== false) {
      review = await step(PHASES.REVIEW, 'Reviewing the changes', async () => {
        const result = await reviewChange({
          projectId: project.id, taskId: task.id, orgId: auth.org.id, userId: auth.user.id,
          project, changedFiles, allowedTiers: options.allowedTiers,
          level: classification.level === 'level0' ? 'level2' : classification.level,
          signal
        });
        budget.record(result.costMicros, 'review');
        return {
          summary: summariseFindings(result.findings),
          detail: { findings: result.findings.length },
          value: result
        };
      }).then(result => result.value).catch(() => null);

      if (review?.findings.length) {
        emit('review', { findings: review.findings, summary: summariseFindings(review.findings) });
        const critical = review.findings.filter(finding => ['critical', 'high'].includes(finding.severity));
        if (critical.length) {
          emit('notice', { level: 'warning', message: `${critical.length} high-severity finding${critical.length === 1 ? '' : 's'} in this change.` });
        }
      }
    }

    if (iteration >= maxIterations && !finalText) {
      finalText = `I reached the ${maxIterations}-step limit for this task without finishing. ${changedFiles.length ? `${changedFiles.length} files were changed — review them before continuing.` : 'No files were changed.'}`;
    }

    // ── 8. finish ────────────────────────────────────────────────────────────
    const result = {
      summary: finalText || 'Task completed.',
      changedFiles,
      validation: validation ? { passed: validation.ok, summary: validation.metadata?.summary } : null,
      review: review ? { findings: review.findings.length, summary: summariseFindings(review.findings) } : null,
      plan,
      model: currentRoute.model.name,
      escalations: state.escalations
    };

    await updateTask(task.id, {
      status: 'completed',
      finished_at: new Date().toISOString(),
      duration_ms: task.started_at ? Date.now() - new Date(task.started_at).getTime() : null,
      spent_micros: budget.spentMicros,
      iterations: state.stepIndex,
      changed_files: changedFiles,
      result
    });

    emit('done', { ...result, budget: budget.toJSON() });
    return { status: 'completed', ...result, budget: budget.toJSON(), iterations: state.stepIndex };
  } catch (error) {
    const app = error instanceof AppError ? error : new AppError(String(error?.message || error));
    const isCancel = app.code === 'cancelled';

    await updateTask(task.id, {
      status: isCancel ? 'cancelled' : 'failed',
      finished_at: new Date().toISOString(),
      spent_micros: budget.spentMicros,
      iterations: state.stepIndex,
      changed_files: [...state.changedFiles.values()],
      error: app.message,
      error_code: app.code
    });

    emit(isCancel ? 'cancelled' : 'error', { message: app.message, code: app.code, budget: budget.toJSON() });
    logger.warn('task ended without completing', { taskId: task.id, status: isCancel ? 'cancelled' : 'failed', code: app.code });

    return {
      status: isCancel ? 'cancelled' : 'failed',
      summary: app.message,
      changedFiles: [...state.changedFiles.values()],
      budget: budget.toJSON(),
      iterations: state.stepIndex
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** The objective the model sees, sharpened by the plan and what has happened. */
function buildObjective(task, plan, state, iteration) {
  if (iteration === 1) {
    if (!plan?.steps?.length) return task.objective;
    return `${task.objective}\n\nPlan:\n${plan.steps.map((step, i) => `${i + 1}. ${step.title}`).join('\n')}`;
  }

  const changed = [...state.changedFiles.values()];
  const progress = changed.length
    ? `Files changed so far: ${changed.map(file => file.path).join(', ')}.`
    : 'No files changed yet.';
  return `${task.objective}\n\n${progress}\nContinue. If the task is done, say so and stop calling tools.`;
}

function parsePlan(text) {
  try {
    const match = String(text).match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    return {
      summary: String(parsed.summary || '').slice(0, 300),
      steps: (Array.isArray(parsed.steps) ? parsed.steps : []).slice(0, 8).map(step => ({
        title: String(step.title || step).slice(0, 200),
        files: (Array.isArray(step.files) ? step.files : []).slice(0, 10).map(file => String(file).slice(0, 300)),
        why: String(step.why || '').slice(0, 200)
      })),
      validation: (Array.isArray(parsed.validation) ? parsed.validation : []).slice(0, 5).map(item => String(item).slice(0, 200)),
      risks: (Array.isArray(parsed.risks) ? parsed.risks : []).slice(0, 5).map(item => String(item).slice(0, 200))
    };
  } catch {
    return { summary: '', steps: [], validation: [], risks: [] };
  }
}

function countPlanFiles(plan) {
  return new Set(plan.steps.flatMap(step => step.files)).size;
}

function describeCall(call) {
  const args = call.arguments || {};
  if (args.path) return args.path;
  if (args.command) return args.command;
  if (args.query) return `"${args.query}"`;
  if (args.name) return args.name;
  if (args.packages) return Array.isArray(args.packages) ? args.packages.join(', ') : String(args.packages);
  return '';
}

function firstLine(text) {
  return String(text || '').split('\n')[0].slice(0, 160);
}

async function updateTask(taskId, patch) {
  if (!hasServiceRole()) return;
  await serviceClient().from('tasks').eq('id', taskId).update(patch).catch(error =>
    logger.warn('task update failed', { taskId, reason: error?.message }));
}

async function persistStep(taskId, index, phase, title, status, summary, detail, durationMs, usage) {
  if (!hasServiceRole()) return;
  await serviceClient().insert('task_steps', {
    task_id: taskId,
    step_index: index,
    phase,
    title: String(title).slice(0, 200),
    status,
    summary: String(summary || '').slice(0, 500),
    detail: detail || {},
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    duration_ms: Math.round(durationMs)
  }, { upsert: true, onConflict: 'task_id,step_index', returning: false }).catch(() => {});
}

export { PHASES, parsePlan, buildObjective };
