/**
 * Sub-agents.
 *
 * A long task and a cheap task pull in opposite directions. Every step a run
 * takes is added to a conversation that is re-sent on the next step, so the
 * fortieth step of a linear run pays for the thirty-nine before it. Reading
 * eleven files to find out where authentication lives costs eleven tool
 * results, and those eleven results stay in front of the model for the rest of
 * the task — long after the only thing that mattered ("it is in src/auth/") has
 * been established.
 *
 * That is what delegation fixes, and it is worth being precise about why,
 * because "spawn a sub-agent" is usually said as though the point were
 * parallelism. It is not. The point is that a child run has its own
 * conversation, and only its conclusion comes back. The parent pays one
 * paragraph for work that would otherwise have cost it eleven tool results
 * forever.
 *
 * Four roles, because a delegated job is one of four things:
 *
 *   explore   find something out. Read-only, cheap model, returns findings.
 *   implement do a scoped piece of the work. Writes, and its changes roll up
 *             to the parent so the restore point and the summary still cover
 *             them.
 *   verify    run the tests and say what broke and why.
 *   review    read a change and report what is wrong with it.
 *
 * What a child cannot do is as important as what it can:
 *
 *   - It cannot pause for approval. A child's state is not persisted, so a
 *     pause would be a loss rather than a wait. When a child hits a call that
 *     needs a person, it stops and hands the decision back to the parent,
 *     which can pause properly.
 *   - It cannot spawn children of its own beyond the configured depth.
 *     Unbounded recursion with a budget attached is a way to spend money.
 *   - It cannot outspend its slice. The parent's remaining budget is charged
 *     as the child works, so a runaway child is bounded twice.
 */

import { complete } from '../ai/gateway.js';
import { route } from '../ai/router.js';
import { systemSetting } from '../ai/catalog.js';
import { assembleContext } from '../context/engine.js';
import { TokenBudget } from '../context/budget.js';
import { toolsFor, toolDefinitions, executeTool } from './tools/index.js';
import { trimConversation } from './runstate.js';
import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { cancelled } from '../core/errors.js';
import { logger } from '../core/logger.js';

/**
 * What each role is for, and what it is allowed to be.
 *
 * `toolset` is the lever that matters. An explorer handed a write tool will
 * eventually use one, and the whole value of delegating a question is that the
 * answer comes back without anything having changed.
 */
export const ROLES = {
  explore: {
    summary: 'Find something out about the codebase and report back. Cannot change anything.',
    toolset: 'read',
    level: 'level1',
    category: 'chat',
    steps: 10,
    maxOutputTokens: 1500,
    instruction:
      'You are looking something up for another agent that is busy with a larger task. ' +
      'Find the answer, then state it plainly: the files and symbols involved, and what they do. ' +
      'Do not change anything, do not propose a plan, and do not pad the answer — the agent reading it wants facts, not prose.'
  },
  implement: {
    summary: 'Carry out one scoped, self-contained piece of the work.',
    toolset: 'full',
    level: null,          // inherits the parent's complexity
    category: 'code',
    steps: 16,
    maxOutputTokens: null,
    instruction:
      'You have been given one self-contained piece of a larger task. Do exactly that piece and nothing beyond it. ' +
      'When it is done, say what you changed, file by file, in a few lines. ' +
      'If the piece turns out to depend on something outside its scope, stop and say so rather than widening it.'
  },
  verify: {
    summary: 'Run the tests or the build and report what fails and why.',
    toolset: 'full',
    level: 'level2',
    category: 'debug',
    steps: 8,
    maxOutputTokens: 1500,
    instruction:
      'Run the project\'s tests or build and report the outcome. If something fails, name the test, the error and the file and line it points at. ' +
      'Diagnose; do not fix. The agent that called you owns the change.'
  },
  review: {
    summary: 'Read a change and report what is wrong with it.',
    toolset: 'read',
    level: 'level2',
    category: 'review',
    steps: 8,
    maxOutputTokens: 1500,
    instruction:
      'Review the change described to you. Report only real problems — a bug, a security hole, a case the code does not handle — with the file and line. ' +
      'Say "no problems found" if that is the truth. Style opinions are not findings.'
  }
};

export const ROLE_NAMES = Object.keys(ROLES);

/** The default limits, when nothing is configured. */
const DELEGATION = { enabled: true, max_children: 6, child_iterations: 14 };

/** How much of the parent's remaining budget one child may use. */
const DEFAULT_SHARE = 0.35;

export async function delegationSettings() {
  const stored = await systemSetting('agent.delegation', {});
  return { ...DELEGATION, ...(stored && typeof stored === 'object' ? stored : {}) };
}

/**
 * The brief a child starts from.
 *
 * Deliberately short. A child that is handed the parent's whole conversation
 * has cost more than it saves — the isolation *is* the feature, and a brief
 * that runs to a page is a sign the work was not scoped before it was handed
 * over.
 */
function childObjective(role, objective, brief) {
  return [
    ROLES[role].instruction,
    '',
    brief ? `Context from the task you are helping with:\n${String(brief).slice(0, 1200)}` : null,
    '',
    `Your job: ${objective}`
  ].filter(line => line !== null).join('\n');
}

/**
 * What comes back to the parent.
 *
 * One paragraph and a file list. Everything the child read, every command it
 * ran and every dead end it followed stays in the child's conversation, which
 * is thrown away — that is the entire economic argument for delegating.
 */
function packResult({ role, objective, text, changed, steps, spentMicros, stopped }) {
  const lines = [
    `[${role}] ${objective}`,
    '',
    String(text || '').trim() || '(the sub-agent finished without a report)'
  ];

  if (changed.length) {
    lines.push('', `Files changed: ${changed.map(file => file.path).join(', ')}`);
  }
  if (stopped) lines.push('', stopped);

  lines.push('', `(${steps} step(s), $${(spentMicros / 1_000_000).toFixed(4)})`);
  return lines.join('\n');
}

/**
 * Run one delegated job.
 *
 * @param {{role:string, objective:string, brief?:string}} request
 * @param {object} parent  { task, project, auth, budget, signal, emit, depth,
 *                           options, classification, recordFileChange, beforeFileChange }
 * @returns {Promise<{ok:boolean, output:string, metadata:object}>}
 */
export async function runSubAgent(request, parent) {
  const role = ROLES[request.role] ? request.role : 'explore';
  const spec = ROLES[role];
  const settings = await delegationSettings();
  const objective = String(request.objective || '').slice(0, 2000);

  const started = Date.now();
  const emit = parent.emit ?? (() => {});

  /*
     The child's slice of the budget.

     Charged against the parent as it is spent rather than at the end, so a
     child that runs long cannot leave the parent believing it has money it has
     already committed.
  */
  const share = Number(parent.share ?? DEFAULT_SHARE);
  const budget = new TokenBudget({
    budgetMicros: Math.max(1, Math.floor(parent.budget.remainingMicros * share)),
    spentMicros: 0,
    level: spec.level || parent.classification?.level || 'level2'
  });

  const currentRoute = await route({
    category: spec.category,
    level: spec.level || parent.classification?.level || 'level2',
    allowedTiers: parent.options?.allowedTiers,
    requireTools: true
  });

  // Its own row, so its cost is visible and its steps are not confused with
  // the parent's. Optional: a deployment without a service role still works,
  // it just has no record of the child afterwards.
  const childTaskId = await createChildTask(parent, { role, objective, budget, currentRoute });

  const maxSteps = Math.min(
    Number(request.steps) || spec.steps,
    Number(settings.child_iterations) || DELEGATION.child_iterations
  );

  const toolOptions = {
    ...parent.toolOptions,
    toolset: spec.toolset,
    // Depth is spent here. A child may delegate only if the configured depth
    // leaves room, and by default it does not.
    canDelegate: (parent.depth ?? 0) + 1 < Number(parent.delegationDepth ?? 2)
  };

  const conversation = [];
  const changed = new Map();
  /** Jobs this child handed on in turn, when the depth allows it. */
  const grandchildren = [];
  let tools = toolsFor({ ...toolOptions, loadedGroups: parent.loadedGroups ?? new Set() });
  let steps = 0;
  let text = '';
  let stopped = null;
  let toolsDirty = false;

  const recordFileChange = (path, kind) => {
    changed.set(path, { path, kind });
    // The parent's summary, restore point and post-run snapshot must cover
    // what a child wrote, or a delegated change is invisible and unrecoverable.
    parent.recordFileChange?.(path, kind);
  };

  emit('delegate', { role, objective, status: 'running', taskId: childTaskId });

  try {
    while (steps < maxSteps) {
      if (parent.signal?.aborted) throw cancelled('The task was stopped');
      if (budget.exhausted) {
        stopped = 'The sub-agent used up its share of the budget before finishing.';
        break;
      }
      steps += 1;

      if (toolsDirty) {
        tools = toolsFor({ ...toolOptions, loadedGroups: parent.loadedGroups ?? new Set() });
        toolsDirty = false;
      }

      const limits = await budget.limits({ model: currentRoute.model, level: budget.level });
      const context = await assembleContext({
        projectId: parent.project?.id,
        orgId: parent.auth.org.id,
        userId: parent.auth.user.id,
        objective: steps === 1 ? childObjective(role, objective, request.brief) : continueObjective(objective, changed),
        mode: spec.toolset === 'read' ? 'ask' : 'agent',
        limits,
        history: conversation,
        project: parent.project,
        budget,
        availableTools: tools
      });

      const result = await complete({
        messages: context.messages,
        routeResult: currentRoute,
        tools: toolDefinitions(tools),
        maxTokens: Math.min(limits.outputTokens, spec.maxOutputTokens ?? limits.outputTokens),
        signal: parent.signal,
        context: {
          orgId: parent.auth.org.id, userId: parent.auth.user.id,
          projectId: parent.project?.id, taskId: childTaskId || parent.task.id
        }
      });

      budget.record(result.costMicros, `delegate:${role}`);
      // The parent pays as the child spends, not afterwards.
      parent.budget.record(result.costMicros, `delegate:${role}`);
      emit('cost', parent.budget.toJSON());

      if (result.text) {
        text = result.text;
        conversation.push({ role: 'assistant', content: result.text });
      }

      if (!result.toolCalls.length) break;

      conversation.push({
        role: 'assistant',
        content: result.text || '',
        tool_calls: result.toolCalls.map(call => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      });

      for (const call of result.toolCalls.slice(0, 6)) {
        if (parent.signal?.aborted) throw cancelled('The task was stopped');

        emit('tool', { id: call.id, name: call.name, status: 'running', description: `[${role}] ${call.name}`, delegated: role });

        const outcome = await executeTool(call, {
          projectId: parent.project?.id,
          project: parent.project,
          orgId: parent.auth.org.id,
          userId: parent.auth.user.id,
          taskId: childTaskId || parent.task.id,
          trust: parent.options?.trust,
          mode: spec.toolset === 'read' ? 'ask' : parent.task.mode,
          role: parent.auth.role,
          signal: parent.signal,
          approvedCalls: new Set(),
          toolOutputLimit: limits.toolOutputChars,
          recordFileChange,
          beforeFileChange: parent.beforeFileChange,
          loadedGroups: parent.loadedGroups ?? new Set(),
          availableGroups: parent.availableGroups ?? new Set(),
          loadGroup: group => { parent.loadedGroups?.add(group); toolsDirty = true; },
          // A child may hand work on in turn, but only while the configured
          // depth lasts. Recursion with a budget attached needs a floor.
          childCount: () => grandchildren.length,
          delegate: toolOptions.canDelegate
            ? async delegation => {
              const outcome = await runSubAgent(delegation, {
                ...parent,
                depth: (parent.depth ?? 0) + 1,
                // Changes made further down still roll up through here, so
                // the top-level run's summary and restore point cover them.
                recordFileChange
              });
              grandchildren.push(outcome.metadata);
              return outcome;
            }
            : undefined,
          onDeliverable: parent.onDeliverable,
          onOutput: chunk => emit('output', { tool: call.name, delegated: role, ...chunk })
        });

        emit('tool', {
          id: call.id, name: call.name, status: outcome.status,
          summary: String(outcome.output || '').split('\n')[0].slice(0, 160),
          description: `[${role}] ${call.name}`, delegated: role
        });

        /*
           A child cannot wait for a person.

           Its conversation is not written down, so pausing would mean losing
           it. Instead the decision goes back to the parent, which holds the
           run state and can pause properly — and which, unlike the child, the
           user is actually watching.
        */
        if (outcome.status === 'awaiting_approval') {
          stopped = `This needs your approval, which a sub-agent cannot ask for: ${outcome.approval?.description || call.name}. `
            + 'Run that step yourself rather than delegating it.';
          conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: stopped });
          steps = maxSteps;
          break;
        }

        conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: outcome.output });
      }

      // Trimmed on a whole turn: a tool result must never outlive its call.
      if (conversation.length > 24) {
        conversation.splice(0, conversation.length, ...trimConversation(conversation));
      }
    }

    if (steps >= maxSteps && !stopped && !text) {
      stopped = `The sub-agent reached its ${maxSteps}-step limit without reporting back.`;
    }

    const output = packResult({
      role, objective, text,
      changed: [...changed.values()],
      steps, spentMicros: budget.spentMicros, stopped
    });

    emit('delegate', {
      role, objective, status: 'completed', taskId: childTaskId,
      steps, changed: changed.size, costMicros: budget.spentMicros
    });

    await finishChildTask(childTaskId, {
      status: 'completed', steps, spentMicros: budget.spentMicros,
      changed: [...changed.values()], summary: text, durationMs: Date.now() - started
    });

    return {
      ok: !stopped,
      output,
      metadata: { role, steps, changed: changed.size, costMicros: budget.spentMicros, taskId: childTaskId }
    };
  } catch (error) {
    emit('delegate', { role, objective, status: 'failed', taskId: childTaskId });
    await finishChildTask(childTaskId, {
      status: 'failed', steps, spentMicros: budget.spentMicros,
      changed: [...changed.values()], summary: error?.message, durationMs: Date.now() - started
    });
    throw error;
  }
}

/** What the child is told on its second and later steps. */
function continueObjective(objective, changed) {
  const files = [...changed.values()].map(file => file.path);
  return [
    objective,
    files.length ? `Changed so far: ${files.join(', ')}.` : null,
    'Continue. When the job is done, report back and stop calling tools.'
  ].filter(Boolean).join('\n');
}

// ─── the child's own record ─────────────────────────────────────────────────

async function createChildTask(parent, { role, objective, budget, currentRoute }) {
  if (!hasServiceRole()) return null;
  try {
    const row = await serviceClient().insert('tasks', {
      org_id: parent.auth.org.id,
      project_id: parent.project?.id ?? null,
      user_id: parent.auth.user.id,
      parent_task_id: parent.task.id,
      delegated_role: role,
      title: `${role}: ${objective.slice(0, 120)}`,
      objective,
      mode: ROLES[role].toolset === 'read' ? 'ask' : 'agent',
      status: 'running',
      complexity: budget.level,
      budget_micros: budget.budgetMicros,
      primary_model_id: currentRoute.model.id,
      started_at: new Date().toISOString()
    }, { returning: true });
    return row?.id ?? null;
  } catch (error) {
    logger.warn('could not record a delegated run', { reason: error?.message });
    return null;
  }
}

async function finishChildTask(taskId, { status, steps, spentMicros, changed, summary, durationMs }) {
  if (!taskId || !hasServiceRole()) return;
  await serviceClient().from('tasks').eq('id', taskId).update({
    status,
    finished_at: new Date().toISOString(),
    duration_ms: Math.round(durationMs),
    spent_micros: spentMicros,
    iterations: steps,
    changed_files: changed,
    result: { summary: String(summary || '').slice(0, 4000) }
  }).catch(() => {});
}

export { packResult, childObjective, DEFAULT_SHARE };
