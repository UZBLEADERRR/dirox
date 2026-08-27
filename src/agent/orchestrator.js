/**
 * The agent loop.
 *
 *   intent -> classify -> plan -> retrieve -> model -> tools -> observe -> validate -> report
 *
 * Intent comes first and costs nothing. It decides how much of the pipeline
 * runs at all: a greeting takes the direct path — no plan, no checkpoint, no
 * retrieval, no tool schemas — while real work takes the whole loop. Complexity
 * routing then decides *which model*; intent decided *how much to send it*.
 *
 * Everything that makes this safe rather than merely clever lives here:
 * iteration limits, loop detection, budget pressure, escalation only after a
 * measured failure, and approval gates that pause the run instead of guessing.
 *
 * Progress is emitted as concise, user-safe activity — never raw reasoning.
 */

import { complete } from '../ai/gateway.js';
import { classify, classifierPrompt, parseClassification, route, escalate } from '../ai/router.js';
import { classifyIntent, intentPrompt, parseIntent, shouldVerifyIntent, PROFILES } from './intent.js';
import { systemSetting } from '../ai/catalog.js';
import { assembleContext } from '../context/engine.js';
import { TokenBudget, defaultBudgetFor } from '../context/budget.js';
import { plannerPrompt } from './prompts.js';
import { toolsFor, toolDefinitions, executeTool, availableGroups } from './tools/index.js';
import { groupsFor } from './tools/groups.js';
import { packRunState, unpackRunState, trimConversation } from './runstate.js';
import { runSubAgent } from './subagent.js';
import { planBatch } from './parallel.js';
import { orientation } from './orientation.js';
import { createCheckpoint, captureOriginal } from './checkpoints.js';
import { reviewChange, summariseFindings } from './review.js';
import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { AppError, cancelled, quotaExceeded } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { runtimeStats } from '../modules/observability/audit.js';

const PHASES = {
  INTENT: 'intent', CLASSIFY: 'classify', PLAN: 'plan', RETRIEVE: 'retrieve', MODEL: 'model',
  TOOL: 'tool', OBSERVE: 'observe', VALIDATE: 'validate', REVIEW: 'review',
  CHECKPOINT: 'checkpoint', DELEGATE: 'delegate', FINALIZE: 'finalize'
};

/**
 * How long a run may go on.
 *
 * There used to be a hard ceiling of forty steps here, and it was the wrong
 * instrument. Forty steps is not a measure of anything: a task that needs
 * sixty is not more dangerous than one that needs thirty, it is just larger,
 * and stopping it at forty produced a half-migrated repository and an apology.
 *
 * Three limits replace it, and each one is a real condition rather than a
 * round number:
 *
 *   budget      the money is gone. This is the honest limit and always was.
 *   stall       several steps in a row produced nothing new — no file changed,
 *               no action attempted that had not already been attempted. A run
 *               in that state does not recover by being given more steps.
 *   deadline    wall-clock. A container is not promised to us forever, and a
 *               run that will be killed mid-write should stop itself first,
 *               with its state written down, while it still can.
 *
 * The iteration count survives only as a ceiling an operator can set, so a
 * misconfigured budget cannot spin forever.
 */
const RUN_LIMITS = {
  max_iterations: 40,
  iteration_ceiling: 200,
  max_runtime_ms: 45 * 60 * 1000,
  stall_window: 6
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
  // Merged rather than defaulted: a deployment whose `agent.defaults` predates
  // these keys would otherwise get none of them, and the run would inherit a
  // ceiling of `undefined`.
  const stored = await systemSetting('agent.defaults', {});
  const defaults = {
    loop_detection_window: 3, escalation_attempts: 2, tool_output_limit: 6000,
    ...RUN_LIMITS,
    ...(stored && typeof stored === 'object' ? stored : {})
  };

  const budget = new TokenBudget({
    budgetMicros: Number(task.budget_micros),
    spentMicros: Number(task.spent_micros || 0),
    level: task.complexity || 'level1'
  });

  /*
     Is there a run here already?

     An approval pause, a redeployed container or a reclaimed worker all leave
     a task that was genuinely part-way through. Restarting it repeats work the
     user has already paid for and, worse, repeats writes. So the loop reads
     back what it wrote down and continues from there.
  */
  const resumed = options.resumeState === false ? null : unpackRunState(task.run_state);

  const state = {
    stepIndex: resumed?.stepIndex ?? Number(task.iterations || 0),
    changedFiles: new Map((resumed?.changedFiles ?? []).map(file => [file.path, file])),
    toolResults: [],
    recentActions: resumed?.recentActions ?? [],
    consecutiveFailures: 0,
    escalations: resumed?.escalations ?? 0,
    checkpointed: Boolean(resumed?.checkpointId),
    checkpointId: resumed?.checkpointId ?? null,
    conversation: resumed?.conversation ?? [],
    deliverables: resumed?.deliverables ?? [],
    /** Tool groups this run has pulled in, beyond the core set. */
    loadedGroups: new Set(resumed?.loadedGroups ?? []),
    /** Distinct actions attempted. Novelty is how progress is measured. */
    signatures: new Set(resumed?.recentActions ?? []),
    /** Iterations since anything new happened. */
    sinceProgress: 0,
    /** Delegated runs this task has spawned. */
    children: resumed?.children ?? [],
    startedAt: Date.now()
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

  /**
   * The direct path, taken when the intent router says there is nothing to
   * look up.
   *
   * This is not a degraded version of the loop — it is the whole response for
   * a conversational turn. It skips the complexity classifier, the plan, the
   * restore point, retrieval and every tool schema, because none of them can
   * improve the answer to "hello" and together they cost thousands of tokens.
   */
  const respondDirectly = async profile => {
    budget.level = profile.level || 'level0';
    if (!task.budget_micros || Number(task.budget_micros) <= 0) {
      budget.budgetMicros = await defaultBudgetFor(budget.level);
    }

    const chatRoute = await route({
      category: profile.category,
      level: profile.level,
      allowedTiers: options.allowedTiers,
      preferredModelId: options.preferredModelId,
      requireTools: false
    });

    emit('model', { name: chatRoute.model.name, level: chatRoute.level, category: chatRoute.category });
    await updateTask(task.id, {
      status: 'running',
      complexity: budget.level,
      primary_model_id: chatRoute.model.id,
      budget_micros: budget.budgetMicros,
      started_at: task.started_at || new Date().toISOString()
    });

    const history = await recentTurns(task.conversation_id, profile.historyTurns);

    const answer = await step(PHASES.MODEL, 'Replying', async () => {
      const context = await assembleContext({
        orgId: auth.org.id,
        userId: auth.user.id,
        objective: task.objective,
        mode: task.mode,
        profile,
        history,
        availableTools: []
      });

      const result = await complete({
        messages: context.messages,
        routeResult: chatRoute,
        maxTokens: profile.maxOutputTokens,
        signal,
        context: { orgId: auth.org.id, userId: auth.user.id, projectId: project?.id, taskId: task.id }
      });

      budget.record(result.costMicros, 'chat');
      emit('cost', budget.toJSON());

      return {
        summary: `${context.tokens} input tokens`,
        detail: { inputTokens: context.tokens, intent: profile.intent },
        usage: result.usage,
        value: result.text
      };
    }).then(result => result.value);

    const result = {
      summary: answer || 'No reply was produced.',
      changedFiles: [],
      validation: null,
      review: null,
      plan: null,
      model: chatRoute.model.name,
      escalations: 0,
      intent: profile.intent
    };

    await updateTask(task.id, {
      status: 'completed',
      finished_at: new Date().toISOString(),
      duration_ms: task.started_at ? Date.now() - new Date(task.started_at).getTime() : null,
      spent_micros: budget.spentMicros,
      iterations: state.stepIndex,
      changed_files: [],
      result
    });

    emit('done', { ...result, budget: budget.toJSON() });
    return { status: 'completed', ...result, budget: budget.toJSON(), iterations: state.stepIndex };
  };

  runtimeStats.agentRun();

  try {
    // ── 0. intent ────────────────────────────────────────────────────────────
    //
    // Before anything is assembled, decide how much this request is allowed to
    // cost. The heuristic is free; a model call to settle it happens only when
    // being wrong would cost more than asking.
    let intent = classifyIntent({
      text: task.objective,
      mode: task.mode,
      hasProject: Boolean(project),
      hasAttachment: Boolean(task.attachments?.length),
      conversationTurns: Number(task.iterations || 0)
    });

    // A resumed run keeps the intent it was already running under: it has a
    // conversation, loaded tool groups and changed files that only make sense
    // under that reading, and re-deciding could take them all away.
    if (resumed?.intent && PROFILES[resumed.intent]) {
      intent = { intent: resumed.intent, profile: PROFILES[resumed.intent], confidence: 1, reason: 'resumed' };
    }

    if (!resumed && shouldVerifyIntent(intent) && budget.pressure === 'comfortable') {
      const verified = await verifyIntent(intent, task, { auth, project, signal, allowedTiers: options.allowedTiers, budget })
        .catch(() => intent);
      intent = verified;
    }

    emit('intent', { intent: intent.intent, reason: intent.reason, confidence: intent.confidence });

    // ── the direct path ──
    //
    // "Salom" needs one sentence of system prompt and the message itself. No
    // plan, no restore point, no retrieval, no tool schemas — roughly forty
    // tokens instead of four thousand, on the most common message there is.
    if (intent.intent === 'chat') {
      return await respondDirectly(intent.profile);
    }

    // ── 1. classify ──────────────────────────────────────────────────────────
    let classification = classify({
      text: task.objective,
      mode: task.mode,
      hasError: /error|exception|traceback|stack trace|failing/i.test(task.objective)
    });

    // A resumed run was already classified, and re-deciding mid-task would
    // change the model under a conversation that is half-finished.
    if (resumed?.level) {
      classification = { ...classification, level: resumed.level, category: resumed.category ?? classification.category, confidence: 1 };
    }

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
      requireTools: intent.intent === 'code' && task.mode !== 'ask'
    });

    emit('model', { name: currentRoute.model.name, level: currentRoute.level, category: currentRoute.category });
    await updateTask(task.id, { primary_model_id: currentRoute.model.id });

    // ── 3. checkpoint before the first change ────────────────────────────────
    // A read-only intent cannot write, so there is nothing to restore. A
    // resumed run already has one, and a second would capture the files as
    // they are *after* the first half of the work — a restore point that
    // restores to the middle of the change is worse than none.
    if (project && !state.checkpointId && intent.intent === 'code' && ['agent', 'autopilot', 'edit', 'debug'].includes(task.mode)) {
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

    /*
       What the repository is, worked out rather than asked about.

       The first thing an agent does on a coding task is find out where it is:
       `inspect_project`, or a directory listing, or `git status`. None of that
       is a judgement — it is `ls`, a manifest and a branch name — and paying a
       whole iteration for it (a model call carrying every tool schema, a tool
       round trip, then another model call to use the answer) is paying a model
       to run code.

       So the run establishes it first, for a few hundred tokens, once.
    */
    const brief = project && intent.intent === 'code'
      ? await orientation(project.id).catch(() => null)
      : null;

    if (brief) {
      emit('step', {
        index: ++state.stepIndex, phase: PHASES.RETRIEVE,
        title: 'Looking around the project', status: 'completed',
        summary: 'Established the project layout and state without a model call'
      });
    }

    // ── 4. plan, for anything non-trivial ────────────────────────────────────
    // A resumed run keeps the plan it was working to. Planning again would
    // cost a model call to produce a plan for work that is already half done.
    let plan = resumed && task.plan && Object.keys(task.plan).length ? task.plan : null;
    if (!plan && intent.intent === 'code' && classification.level !== 'level0' && task.mode !== 'ask') {
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
          messages: [
            ...context.messages.filter(m => m.role === 'system'),
            // The planner plans better knowing what it is planning inside.
            ...(brief ? [{ role: 'system', content: brief }] : []),
            ...plannerPrompt(task.objective, {
              fileCount: context.retrieval.files.length, mode: task.mode
            })
          ],
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

    /*
       Tools are no longer fixed for the run.

       The core set travels on every call; the rest is fetched by name when a
       step needs it. What the objective already asks for is loaded up front —
       a task that says "open a pull request" will need GitHub on its first
       step, and making it ask would waste a call in both directions.
    */
    const delegationDepth = Math.max(0, Number(defaults.delegation_depth ?? 2));

    const toolOptions = {
      mode: task.mode,
      toolset: intent.profile.toolset,
      featureFlags: options.featureFlags || {},
      hasRepository: Boolean(project),
      hasDevCommand: Boolean(project?.dev_command),
      hasGitHub: options.hasGitHub !== false,
      hasSupabase: options.hasSupabase === true,
      includeGitHub: intent.profile.github === true,
      // Depth is spent by delegating: a top-level run has all of it, a
      // sub-agent's run has one less, and at zero the tool is not offered.
      canDelegate: delegationDepth > 0
    };

    const groupsAvailable = availableGroups(toolOptions);

    for (const group of groupsFor(task.objective)) {
      if (groupsAvailable.has(group)) state.loadedGroups.add(group);
    }

    let tools = toolsFor({ ...toolOptions, loadedGroups: state.loadedGroups });
    if (state.loadedGroups.size) {
      emit('notice', { level: 'info', message: `Loaded tools: ${[...state.loadedGroups].join(', ')}.` });
    }

    /*
       How long this run may go on.

       The requested length is the task's own, the ceiling is the operator's,
       and neither is the limit that usually bites: budget, stalling and the
       wall clock are. A ceiling still exists so a misconfigured budget cannot
       spin forever, but it is set where a real task will not meet it.
    */
    const ceiling = Math.max(1, Number(defaults.iteration_ceiling) || RUN_LIMITS.iteration_ceiling);
    const maxIterations = Math.min(
      Number(task.max_iterations) || Number(defaults.max_iterations) || RUN_LIMITS.max_iterations,
      ceiling
    );
    const deadline = state.startedAt + (Number(defaults.max_runtime_ms) || RUN_LIMITS.max_runtime_ms);
    const stallWindow = Math.max(2, Number(defaults.stall_window) || RUN_LIMITS.stall_window);

    /*
       Iterations count this attempt, not the task's whole history.

       A resumed run has to be able to do work, and a cumulative count would
       mean a run that stopped at its ceiling could only ever resume into the
       same wall. Total spend is bounded by the budget, which *is* cumulative —
       `spent_micros` is carried across attempts — so nothing is unbounded here.
       `state.stepIndex` keeps the numbering continuous for the timeline.
    */
    const priorIterations = resumed?.iteration ?? 0;
    let iteration = 0;
    let finalText = resumed?.finalText ?? '';
    let pendingApproval = null;
    /** Why the loop stopped, when it was not the model deciding it was done. */
    let stopReason = null;

    /**
     * Write down enough to continue.
     *
     * Called after every iteration and before every pause. The cost is one
     * update per step against a row we are already updating; what it buys is a
     * run that survives the container it started in.
     */
    const saveRunState = async (pendingCalls = []) => {
      await updateTask(task.id, {
        iterations: state.stepIndex,
        spent_micros: budget.spentMicros,
        changed_files: [...state.changedFiles.values()],
        run_state: packRunState(state, {
          iteration: priorIterations + iteration,
          intent: intent.intent,
          category: classification.category,
          level: classification.level,
          finalText,
          pendingCalls
        })
      });
    };

    /** One tool call, with the whole execution context it needs. */
    const executeOne = async (call, limits) => {
      emit('tool', { id: call.id, name: call.name, status: 'running', description: describeCall(call) });

      const result = await executeTool(call, {
        projectId: project?.id,
        project,
        orgId: auth.org.id,
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
        // The loader records; the loop applies. A tool cannot widen the
        // request it is already running inside.
        loadedGroups: state.loadedGroups,
        availableGroups: groupsAvailable,
        loadGroup: group => { state.loadedGroups.add(group); state.toolsDirty = true; },
        /*
           Delegation.

           The child gets its own conversation, its own slice of the budget
           and its own row; the parent gets a paragraph. What it does not get
           is a separate view of the work: file changes, deliverables and
           spend all roll up here, so a delegated change is still covered by
           the restore point, the summary and the post-run snapshot.
        */
        childCount: () => state.children.length,
        delegate: async delegation => {
          const outcome = await runSubAgent(delegation, {
            task, project, auth, budget, signal, emit,
            depth: 0,
            delegationDepth,
            share: Number(defaults.delegation_budget_share ?? 0.35),
            options,
            classification,
            toolOptions,
            loadedGroups: state.loadedGroups,
            availableGroups: groupsAvailable,
            recordFileChange,
            beforeFileChange,
            onDeliverable: file => {
              state.deliverables.push(file);
              emit('deliverable', file);
            }
          });
          state.children.push({
            role: delegation.role,
            objective: delegation.objective,
            ...outcome.metadata
          });
          return outcome;
        },
        // A file the user can save is worth its own event: the chat shows it
        // as soon as it exists rather than only in the closing summary.
        onDeliverable: file => {
          state.deliverables.push(file);
          emit('deliverable', file);
        },
        onOutput: chunk => emit('output', { tool: call.name, ...chunk })
      });

      emit('tool', {
        id: call.id, name: call.name, status: result.status,
        summary: firstLine(result.output), description: describeCall(call)
      });

      return result;
    };

    /**
     * Run one turn's tool calls.
     *
     * Read-only calls that sit next to each other run together; everything
     * else runs alone, in the order it was asked for. Four `read_file` calls
     * in one turn used to take four round trips of waiting for no reason —
     * nothing about any of them depends on the others.
     *
     * Results always go back in the order the model asked for them, whatever
     * order they finished in, because the model reasons about its own
     * ordering and a shuffled batch reads as a different set of answers.
     *
     * Returns the calls that never ran. When one stops for approval, the ones
     * queued behind it have to be remembered, or resuming leaves an assistant
     * turn whose tool calls have no results — which every provider rejects.
     */
    const runCalls = async (calls, limits) => {
      let anyFailed = false;
      state.toolResults = [];

      // Loop detection runs over the whole turn first. It has to: a repeated
      // action is a reason to stop before any of the batch executes, not after
      // half of it has.
      for (const call of calls) {
        const signature = `${call.name}:${JSON.stringify(call.arguments ?? {}).slice(0, 200)}`;
        state.recentActions.push(signature);
        if (state.recentActions.length > 12) state.recentActions.shift();
        const repeats = state.recentActions.filter(action => action === signature).length;
        state.signatures.add(signature);

        if (repeats > (defaults.loop_detection_window ?? 3)) {
          emit('notice', { level: 'warning', message: `Stopping: the same action (${call.name}) was repeated ${repeats} times without progress.` });
          finalText = finalText || `I repeated the same action (${call.name}) without making progress, so I stopped rather than continuing to spend budget. The underlying problem may need a different approach.`;
          stopReason = 'loop';
          return { anyFailed, remaining: [] };
        }
      }

      const groups = await planBatch(calls, { projectId: project?.id, project, userId: auth.user.id });
      let index = 0;

      for (const group of groups) {
        abortIfCancelled();

        const results = group.length === 1
          ? [await executeOne(group[0], limits)]
          : await Promise.all(group.map(call => executeOne(call, limits)));

        for (const [offset, result] of results.entries()) {
          const call = group[offset];

          if (result.status === 'awaiting_approval') {
            pendingApproval = result.approval;
            // This call and everything behind it: none of them ran. Only a
            // call that runs alone can reach this, so nothing in flight is
            // being abandoned.
            return { anyFailed, remaining: calls.slice(index + offset) };
          }

          state.toolResults.push({ toolCallId: call.id, tool: call.name, output: result.output });
          state.conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result.output });

          if (!result.ok) anyFailed = true;
        }

        index += group.length;
      }

      return { anyFailed, remaining: [] };
    };

    /*
       A run picked up mid-flight.

       The calls that were waiting on a person run first, before the model is
       asked for anything new. Only then does the conversation make sense
       again: every tool call in it has a result.
    */
    if (resumed?.pendingCalls?.length && !budget.exhausted) {
      emit('notice', { level: 'info', message: `Continuing where this task stopped, at step ${state.stepIndex}.` });
      const limits = await budget.limits({ model: currentRoute.model, level: classification.level });
      const outcome = await runCalls(resumed.pendingCalls, limits);
      state.consecutiveFailures = outcome.anyFailed ? 1 : 0;
      if (pendingApproval) {
        await saveRunState(outcome.remaining);
      }
    }

    while (!pendingApproval && !stopReason && iteration < maxIterations) {
      abortIfCancelled();
      iteration += 1;

      if (budget.exhausted) {
        finalText = finalText || 'The task budget was used up before the work could be finished.';
        emit('notice', { level: 'warning', message: 'Budget exhausted — stopping to avoid further spend.' });
        stopReason = 'budget';
        break;
      }

      // The wall clock. A container is not promised to us indefinitely, and a
      // run that stops itself with its state written down can be continued;
      // one killed mid-write cannot.
      if (Date.now() > deadline) {
        emit('notice', { level: 'warning', message: 'This run reached its time limit and stopped with its progress saved. Ask it to continue.' });
        finalText = finalText || 'I reached the time limit for a single run. The work so far is saved — ask me to continue and I will pick it up.';
        stopReason = 'deadline';
        break;
      }

      // A group loaded on the previous step becomes available on this one.
      if (state.toolsDirty) {
        tools = toolsFor({ ...toolOptions, loadedGroups: state.loadedGroups });
        state.toolsDirty = false;
      }

      const limits = await budget.limits({ model: currentRoute.model, level: classification.level });

      // What counts as progress: something changed, or something was tried
      // that had not been tried before. Measured across the iteration.
      const before = { actions: state.signatures.size, files: state.changedFiles.size, children: state.children.length };

      // ── retrieve ──
      const context = await step(PHASES.RETRIEVE, 'Gathering context', async () => {
        const assembled = await assembleContext({
          projectId: project?.id,
          orgId: auth.org.id,
          userId: auth.user.id,
          objective: buildObjective(task, plan, state, priorIterations + iteration, brief),
          mode: task.mode,
          limits,
          history: state.conversation,
          toolResults: state.toolResults.slice(-4),
          taskFiles: [...state.changedFiles.keys()],
          project,
          budget,
          profile: intent.profile,
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
          stopReason = 'budget';
          break;
        }
      }

      const title = iteration === 1 && !priorIterations ? 'Working on the task' : 'Continuing';
      const response = await step(PHASES.MODEL, title, async () => {
        const result = await complete({
          messages: context.messages,
          routeResult: currentRoute,
          tools: toolDefinitions(tools),
          // The intent's ceiling and the budget's ceiling, whichever is lower.
          // A question does not need room for a 16,000-token answer.
          maxTokens: Math.min(limits.outputTokens, intent.profile.maxOutputTokens ?? limits.outputTokens),
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

      const outcome = await runCalls(response.toolCalls.slice(0, 8), limits);

      if (pendingApproval) {
        await saveRunState(outcome.remaining);
        break;
      }

      // ── escalate only after a measured failure ──
      state.consecutiveFailures = outcome.anyFailed ? state.consecutiveFailures + 1 : 0;
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

      /*
         Stalling.

         Loop detection catches the same call repeated verbatim. This catches
         the subtler version: several iterations in a row where nothing new was
         attempted and nothing changed — a model reading the same four files in
         a different order, or reasoning in circles without touching anything.
         Neither recovers by being given more steps, and both cost money for
         every one it is given.
      */
      const progressed = state.signatures.size > before.actions
        || state.changedFiles.size > before.files
        || state.children.length > before.children;
      state.sinceProgress = progressed ? 0 : state.sinceProgress + 1;

      if (state.sinceProgress >= stallWindow) {
        emit('notice', { level: 'warning', message: `Stopping: ${state.sinceProgress} steps in a row produced nothing new.` });
        finalText = finalText || `I went ${state.sinceProgress} steps without making progress, so I stopped rather than spending more of the budget. ${state.changedFiles.size ? 'The changes made so far are saved.' : 'Nothing was changed.'}`;
        stopReason = 'stalled';
        break;
      }

      // Trim the conversation so it cannot grow without bound — on a whole
      // turn, so a tool result never outlives the call that produced it.
      if (state.conversation.length > 24) state.conversation = trimConversation(state.conversation);

      await saveRunState();
    }

    if (iteration >= maxIterations && !stopReason) stopReason = 'iterations';

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

    if (stopReason === 'iterations' && !finalText) {
      finalText = `I reached this run's step ceiling (${maxIterations}) without finishing. The work so far is saved — ask me to continue and I will pick it up from here. ${changedFiles.length ? `${changedFiles.length} file(s) were changed.` : 'No files were changed.'}`;
    }

    // ── 8. finish ────────────────────────────────────────────────────────────
    const result = {
      summary: finalText || 'Task completed.',
      changedFiles,
      deliverables: state.deliverables,
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
      // The loop is over, so there is nothing to pick up. Leaving the state
      // behind would mean a re-run of this task resumed a conversation that
      // had already reached its answer.
      run_state: {},
      result
    });

    emit('done', { ...result, budget: budget.toJSON() });
    return { status: 'completed', ...result, budget: budget.toJSON(), iterations: state.stepIndex, stopReason };
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

/**
 * Settle an uncertain intent with the cheapest model there is.
 *
 * Worth roughly 120 tokens. It runs only when the heuristic is unsure *and*
 * leaning towards an expensive intent, because that is the only case where
 * being wrong costs more than asking.
 */
async function verifyIntent(guess, task, { auth, project, signal, allowedTiers, budget }) {
  const cheapRoute = await route({ category: 'classify', level: 'level0', allowedTiers });
  const result = await complete({
    messages: intentPrompt(task.objective),
    routeResult: cheapRoute,
    temperature: 0,
    maxTokens: 20,
    responseFormat: 'json',
    cache: true,
    signal,
    context: { orgId: auth.org.id, userId: auth.user.id, projectId: project?.id, taskId: task.id }
  });
  budget.record(result.costMicros, 'intent');
  return parseIntent(result.text, guess);
}

/** The last few turns of the conversation, and nothing more. */
async function recentTurns(conversationId, limit = 4) {
  if (!conversationId || !hasServiceRole() || limit <= 0) return [];
  try {
    const rows = await serviceClient().from('messages')
      .select('role,content')
      .eq('conversation_id', conversationId)
      .eq('compacted', false)
      .order('sequence', { ascending: false })
      .limit(limit)
      .all();
    return rows.reverse()
      .filter(row => row.role === 'user' || row.role === 'assistant')
      .map(row => ({ role: row.role, content: String(row.content || '').slice(0, 2000) }));
  } catch {
    return [];
  }
}

/** The objective the model sees, sharpened by the plan and what has happened. */
function buildObjective(task, plan, state, iteration, brief = null) {
  if (iteration === 1) {
    // The orientation brief travels on the first step only. After that the
    // conversation carries what the run has learned, and repeating the layout
    // on every call would be paying for the same paragraph forty times.
    const opening = [task.objective, brief].filter(Boolean).join('\n\n');
    if (!plan?.steps?.length) return opening;
    return `${opening}\n\nPlan:\n${plan.steps.map((step, i) => `${i + 1}. ${step.title}`).join('\n')}`;
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
