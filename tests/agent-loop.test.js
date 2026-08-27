/**
 * What a request actually costs, measured through the real loop.
 *
 * The gateway, the catalogue and the database are replaced; everything between
 * `runTask` and the model call is the real code. That is the point: the claim
 * being tested is that a greeting reaches the model with no tools, no history
 * and no repository context, and only an end-to-end run can show it.
 *
 * Requires --experimental-test-module-mocks (see package.json).
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const SRC = new URL('../src/', import.meta.url).href;

/** Every call the loop made to a model, in order, and what it should answer. */
let calls = [];
let reply = 'Salom! Nima qilib beray?';

/**
 * Answers queued ahead of `reply`, for cases that need more than one turn.
 *
 * Each entry is `{ text, toolCalls }`. When the queue empties the loop gets
 * `reply` with no tool calls, which is how a scripted run ends.
 */
let script = [];

/** What the planner answers, when a case needs a real plan. */
let plannedSteps = null;

const MODEL = {
  id: 'model-1', code: 'test/haiku', name: 'Test Haiku', max_output: 8192,
  supports_tools: true, supports_prompt_cache: true, supports_vision: false,
  input_price_micros: 800, output_price_micros: 4000, context_window: 200_000,
  tiers: ['level0', 'level1', 'level2'], user_selectable: true
};

/**
 * Is this the pipeline deciding, rather than the agent working?
 *
 * Intent, complexity and the planner are all model calls, and if they took
 * entries off a test's script every assertion about "the second turn" would
 * depend on whether a heuristic happened to be confident that day.
 */
function isRouterCall(request) {
  return (request.messages ?? []).some(message =>
    /^(Classify|Produce a short implementation plan)/.test(String(message.content ?? '')));
}

// Mocks are installed once: a module cannot be mocked twice in one process.
{
  mock.module(`${SRC}ai/gateway.js`, {
    namedExports: {
      async complete(request) {
        calls.push(request);

        /*
           The routers and the planner answer for themselves.

           `{}` is a reply all three parsers reject, so each falls back to its
           own heuristic — which is the code under test in those cases anyway.
        */
        if (isRouterCall(request)) {
          const planning = (request.messages ?? []).some(message =>
            /^Produce a short implementation plan/.test(String(message.content ?? '')));
          return {
            text: planning && plannedSteps ? JSON.stringify(plannedSteps) : '{}',
            toolCalls: [],
            usage: { inputTokens: 30, outputTokens: 4, cachedInputTokens: 0 },
            costMicros: 24, finishReason: 'stop', model: MODEL
          };
        }

        const next = script.length ? script.shift() : null;
        return {
          text: next ? (next.text ?? '') : reply,
          toolCalls: next?.toolCalls ?? [],
          usage: { inputTokens: 30, outputTokens: 12, cachedInputTokens: 0 },
          costMicros: 24,
          finishReason: next?.toolCalls?.length ? 'tool_calls' : 'stop',
          model: MODEL
        };
      }
    }
  });

  mock.module(`${SRC}ai/catalog.js`, {
    namedExports: {
      async systemSetting(_key, fallback) { return fallback; },
      async loadCatalog() { return { models: [MODEL], modelsById: new Map([[MODEL.id, MODEL]]), providers: new Map(), routes: [] }; },
      preferenceAllowed() { return true; }
    }
  });

  mock.module(`${SRC}db/supabase.js`, {
    namedExports: {
      hasServiceRole() { return false; },
      serviceClient() { throw new Error('the loop must not reach the database in this test'); },
      userClient() { throw new Error('not used'); }
    }
  });

  // The classifier is the real one; only the resolution to a concrete model
  // is replaced, because that is the part that needs a catalogue.
  const realRouter = await import(`${SRC}ai/router.js`);
  mock.module(`${SRC}ai/router.js`, {
    namedExports: {
      ...realRouter,
      async route(request) {
        return {
          model: MODEL, provider: { code: 'test', adapter: 'openai' }, fallback: null,
          category: request.category, level: request.level, source: 'test',
          temperature: 0.2, maxOutputTokens: 4096, maxInputTokens: 100_000, reasoningEffort: null
        };
      },
      async escalate() { return null; }
    }
  });
}

/** Start each case from a clean record. */
function fresh(answer, turns = [], plan = null) {
  calls = [];
  reply = answer;
  script = turns;
  plannedSteps = plan;
}

/**
 * A model turn that calls one tool.
 *
 * The tool does not exist, and that is deliberate: `executeTool` answers an
 * unknown name without touching the filesystem or the database, so the loop's
 * own behaviour — how long it runs, what it counts as progress — can be
 * measured without a workspace standing in the way.
 */
function callTool(name, args = {}) {
  return { text: '', toolCalls: [{ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] };
}

/** The model calls that were the agent working, not the pipeline deciding. */
function turns(all = calls) {
  return all.filter(call => !isRouterCall(call));
}

/** Run one objective through the real loop and report what the model saw. */
async function run(objective, { mode = 'agent', project = null, ...overrides } = {}) {
  const { runTask } = await import(`${SRC}agent/orchestrator.js`);
  const events = [];

  const result = await runTask(
    {
      id: 'task-1', objective, mode, title: objective.slice(0, 40),
      budget_micros: 100_000, spent_micros: 0, iterations: 0,
      conversation_id: null, max_iterations: 4,
      ...overrides
    },
    {
      project,
      auth: { user: { id: 'user-1' }, org: { id: 'org-1' }, role: 'owner' },
      emit: (type, data) => events.push({ type, data })
    }
  );

  return { result, events, calls };
}

test('a greeting reaches the model with nothing attached to it', async () => {
  fresh('Salom! Nima qilib beray?');

  const { result, events, calls: made } = await run('Salom');

  assert.equal(result.status, 'completed');
  assert.equal(made.length, 1, 'a greeting is one model call, not a pipeline');

  const [call] = made;
  assert.ok(!call.tools?.length, `a greeting was sent ${call.tools?.length ?? 0} tool schemas`);
  assert.equal(call.maxTokens, 400, 'the intent caps the answer length');

  const systemMessages = call.messages.filter(message => message.role === 'system');
  assert.equal(systemMessages.length, 1, 'one line of policy, and no repository layer');
  assert.match(systemMessages[0].content, /^You are DiroxCode/);
  assert.ok(systemMessages[0].content.length < 160, 'the minimal policy is one or two sentences');

  assert.equal(call.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(call.messages.at(-1).content, 'Salom');

  const { estimateMessageTokens } = await import(`${SRC}ai/pricing.js`);
  const tokens = estimateMessageTokens(call.messages);
  assert.ok(tokens < 60, `a greeting cost ${tokens} input tokens; the ceiling is 60`);

  // No plan, no restore point: neither can improve the answer to "hello".
  const phases = events.filter(event => event.type === 'step').map(event => event.data.phase);
  assert.ok(!phases.includes('plan'), 'a greeting must not be planned');
  assert.ok(!phases.includes('checkpoint'), 'a greeting cannot change a file, so nothing needs restoring');
  assert.ok(!phases.includes('retrieve'), 'there is nothing to retrieve');

  const intent = events.find(event => event.type === 'intent');
  assert.equal(intent?.data.intent, 'chat');
});

test('a courtesy message is just as cheap', async () => {
  fresh('Arzimaydi.');

  const { calls: made } = await run('rahmat');
  assert.equal(made.length, 1);
  assert.ok(!made[0].tools?.length);
});

test('a real request still gets the whole pipeline', async () => {
  fresh('Done.');

  const project = {
    id: 'project-1', name: 'api', dev_command: null, test_command: null,
    index_status: 'ready', language: 'JavaScript'
  };
  const { events, calls: made } = await run('Add rate limiting to the login endpoint', { project });

  const intent = events.find(event => event.type === 'intent');
  assert.equal(intent?.data.intent, 'code');

  const phases = events.filter(event => event.type === 'step').map(event => event.data.phase);
  assert.ok(phases.includes('retrieve'), 'a change needs context');

  // A coding task carries the core set, not everything. The measurement that
  // prompted this: on a sixteen-step run, schemas were half the input tokens
  // and forty-one of the forty-nine tools were never called.
  const modelCall = made.at(-1);
  const names = (modelCall.tools || []).map(tool => tool.function?.name ?? tool.name);

  for (const required of ['read_file', 'edit_file', 'execute_command', 'search_code']) {
    assert.ok(names.includes(required), `a coding task needs ${required} without asking`);
  }
  assert.ok(names.includes('load_tools'), 'and a way to reach everything else');
  assert.ok(names.length < 16, `${names.length} tools travelled; the core set is meant to be small`);
});

test('the objective decides what is loaded before the first call', async () => {
  fresh('Done.');

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { calls: made } = await run('open a pull request for the rate limiting branch', { project });

  const names = (made.at(-1).tools || []).map(tool => tool.function?.name ?? tool.name);
  assert.ok(names.includes('github_open_pull_request'),
    'a task that says "pull request" should not spend a round trip asking for GitHub');
});

test('a task that needs nothing extra carries nothing extra', async () => {
  fresh('Done.');

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { calls: made } = await run('rename the helper in src/util.js', { project });

  const names = (made.at(-1).tools || []).map(tool => tool.function?.name ?? tool.name);
  assert.ok(!names.some(name => name.startsWith('github_')), 'no GitHub tools were asked for');
  assert.ok(!names.some(name => name.startsWith('supabase_')), 'no database tools were asked for');
});

test('a question is answered read-only, with a small toolset', async () => {
  fresh('It routes by category and level.');

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { events, calls: made } = await run('what does the model router do in this project?', { project });

  assert.equal(events.find(event => event.type === 'intent')?.data.intent, 'ask');

  const names = (made.at(-1).tools || []).map(tool => tool.function?.name ?? tool.name);
  assert.ok(names.length > 0 && names.length <= 6, `a question was sent ${names.length} tools`);
  assert.ok(!names.some(name => /write|delete|run_command|commit|install/.test(name)),
    `a question must not be handed a way to change anything: ${names.join(', ')}`);
});

// ─── how long a run may go on ───────────────────────────────────────────────

test('a long task is no longer cut off at forty steps', async () => {
  // Sixty distinct actions: nothing repeats, nothing stalls, and the budget is
  // ample. The old ceiling stopped this at forty with an apology.
  const scripted = Array.from({ length: 60 }, (_, index) => callTool(`step_${index}`));
  fresh('Finished the migration.', scripted);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result, calls: made } = await run('port the whole data layer to Postgres', {
    project, max_iterations: 61, budget_micros: 5_000_000
  });

  assert.equal(result.status, 'completed');
  const worked = turns(made);
  assert.equal(worked.length, 61, `the run stopped after ${worked.length} turns; it was scripted for 61`);
  assert.equal(result.summary, 'Finished the migration.');
});

test('a run that cycles without learning anything stops itself', async () => {
  /*
     Twelve distinct actions, then the same twelve again, forever.

     Loop detection never fires: no single action repeats often enough inside
     its window. What is wrong here is subtler — the run is busy and going
     nowhere, which is the expensive failure mode a step ceiling used to hide.
  */
  const cycle = Array.from({ length: 12 }, (_, index) => `look_${index}`);
  const scripted = Array.from({ length: 90 }, (_, index) => callTool(cycle[index % 12]));
  fresh('Done.', scripted);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result, calls: made } = await run('work out why the tests are flaky', {
    project, max_iterations: 90, budget_micros: 5_000_000
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stopReason, 'stalled', `the run stopped because: ${result.stopReason}`);
  assert.ok(turns(made).length < 30, `${turns(made).length} turns before the stall was noticed`);
  assert.match(result.summary, /without making progress/);
});

test('a run picked up mid-flight does not start over', async () => {
  fresh('Continued and finished.');

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { events, calls: made } = await run('finish the billing work', {
    project,
    complexity: 'level2',
    plan: { summary: 'existing plan', steps: [{ title: 'step one', files: [] }] },
    run_state: {
      version: 1,
      iteration: 7,
      stepIndex: 21,
      category: 'code',
      level: 'level2',
      intent: 'code',
      checkpointId: 'checkpoint-1',
      loadedGroups: ['github'],
      changedFiles: [{ path: 'src/billing.js', kind: 'modified' }],
      conversation: [
        { role: 'assistant', content: 'I added the webhook handler.' }
      ],
      pendingCalls: [],
      recentActions: []
    }
  });

  const phases = events.filter(event => event.type === 'step').map(event => event.data.phase);
  assert.ok(!phases.includes('plan'), 'a resumed run must not pay to plan work that is half done');
  assert.ok(!phases.includes('checkpoint'), 'a second restore point would restore to the middle of the change');

  // The step numbering continues rather than restarting at one.
  const indexes = events.filter(event => event.type === 'step').map(event => event.data.index);
  assert.ok(Math.min(...indexes) > 21, `the timeline restarted at step ${Math.min(...indexes)}`);

  // What the run already knew is in front of the model.
  const sent = JSON.stringify(made.at(-1).messages);
  assert.match(sent, /I added the webhook handler/);
  assert.match(sent, /src\/billing\.js/);

  // And the tool group it had already paid to load is still loaded.
  const names = (made.at(-1).tools || []).map(tool => tool.function?.name ?? tool.name);
  assert.ok(names.some(name => name.startsWith('github_')), 'the loaded group was dropped on resume');
});

// ─── sub-agents ─────────────────────────────────────────────────────────────

test('what a sub-agent read stays with the sub-agent', async () => {
  /*
     The claim being tested is the only one that justifies delegation at all.

     A child reads, runs and abandons things; all of that lives in its own
     conversation and is thrown away. The parent receives the conclusion. If
     the child's tool results leaked back into the parent's history, delegating
     would cost more than doing the work inline.
  */
  fresh('I used the finding and made the change.', [
    callTool('delegate', { role: 'explore', objective: 'find where authentication lives' }),
    callTool('probe_the_auth_directory'),        // the child's first step
    { text: 'Auth lives in src/auth/session.js.', toolCalls: [] }   // the child reports
  ]);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result, calls: made } = await run('rework the session handling', {
    project, budget_micros: 5_000_000
  });

  assert.equal(result.status, 'completed');

  const parentFinal = JSON.stringify(turns(made).at(-1).messages);
  assert.match(parentFinal, /Auth lives in src\/auth\/session\.js/, 'the parent never received the conclusion');
  assert.ok(!parentFinal.includes('probe_the_auth_directory'),
    'the child\'s tool traffic leaked into the parent\'s conversation');
});

test('an explorer is given no way to change anything', async () => {
  fresh('Done.', [
    callTool('delegate', { role: 'explore', objective: 'find the rate limiter' }),
    { text: 'It is in src/core/limit.js.', toolCalls: [] }
  ]);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { calls: made } = await run('replace the rate limiter', { project, budget_micros: 5_000_000 });

  // Calls: parent, child, parent. The middle one is the sub-agent's.
  const childTools = (turns(made)[1].tools || []).map(tool => tool.function?.name ?? tool.name);
  assert.ok(childTools.length > 0, 'the sub-agent was sent no tools at all');
  assert.ok(!childTools.some(name => /write|edit|delete|move|commit|install|execute/.test(name)),
    `an explorer was handed: ${childTools.join(', ')}`);
});

test('a sub-agent spends the parent\'s money, and the parent knows', async () => {
  fresh('Done.', [
    callTool('delegate', { role: 'explore', objective: 'find the config loader' }),
    callTool('look_at_config'),
    { text: 'src/config/env.js.', toolCalls: [] }
  ]);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result, calls: made } = await run('move the config loader', { project, budget_micros: 5_000_000 });

  // Four turns at 24 micros each: two the parent took, two the child did.
  assert.equal(turns(made).length, 4);
  assert.equal(result.budget.spentMicros, made.length * 24,
    'the child\'s spend did not reach the parent\'s budget');
});

test('delegation is not offered to a run that cannot use it', async () => {
  fresh('It routes by category and level.');

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { calls: made } = await run('what does the model router do in this project?', { project });

  const names = (made.at(-1).tools || []).map(tool => tool.function?.name ?? tool.name);
  assert.ok(!names.includes('delegate'), 'a read-only question was handed a way to spawn runs');
});

test('delegating keeps the parent small, which is the whole point', async () => {
  /*
     The same eight lookups, done two ways.

     Inline, each result joins the parent's conversation and is re-sent on
     every later step. Delegated, they join the child's conversation and are
     thrown away when it reports. The number below is what that difference is
     worth on the turn where the parent actually does the work.
  */
  const { estimateMessageTokens } = await import(`${SRC}ai/pricing.js`);
  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const lookups = Array.from({ length: 8 }, (_, index) => callTool(`inspect_module_${index}`));

  fresh('Auth lives in src/auth/session.js; here is the change.', lookups);
  const inline = await run('rewrite the session handling across the auth module', {
    project, max_iterations: 20, budget_micros: 5_000_000
  });
  const inlineFinal = estimateMessageTokens(turns(inline.calls).at(-1).messages);

  fresh('Auth lives in src/auth/session.js; here is the change.', [
    callTool('delegate', { role: 'explore', objective: 'find every module that touches sessions' }),
    ...lookups,
    { text: 'Sessions are handled in src/auth/session.js and read in eight modules.', toolCalls: [] }
  ]);
  const delegated = await run('rewrite the session handling across the auth module', {
    project, max_iterations: 20, budget_micros: 5_000_000
  });
  const delegatedFinal = estimateMessageTokens(turns(delegated.calls).at(-1).messages);

  assert.ok(delegatedFinal < inlineFinal * 0.6,
    `the parent's closing turn cost ${delegatedFinal} tokens delegated against ${inlineFinal} inline — delegation is not paying for itself`);
});

test('a batch of reads comes back in the order it was asked for', async () => {
  /*
     The calls run together; the answers must not arrive shuffled. A model
     reasons about its own ordering — "read the route file, then the handler,
     then the test" — and a batch returned out of order reads as a different
     set of answers to a different set of questions.
  */
  fresh('Read all three.', [{
    text: '',
    toolCalls: [
      { id: 'c-1', name: 'first_lookup', arguments: {} },
      { id: 'c-2', name: 'second_lookup', arguments: {} },
      { id: 'c-3', name: 'third_lookup', arguments: {} }
    ]
  }]);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { calls: made } = await run('read the three session files and summarise them', {
    project, budget_micros: 5_000_000
  });

  const results = turns(made).at(-1).messages
    .filter(message => message.role === 'tool')
    .map(message => message.tool_call_id);

  assert.deepEqual(results.slice(0, 3), ['c-1', 'c-2', 'c-3'],
    `the answers came back as ${results.join(', ')}`);
});

// ─── the plan, and asking before starting ───────────────────────────────────

const PLAN = {
  summary: 'Add a rate limiter to the login endpoint.',
  steps: [
    { title: 'Write the limiter', files: ['src/core/limit.js'] },
    { title: 'Apply it to the login route', files: ['src/auth/routes.js'] },
    { title: 'Cover it with tests', files: ['tests/limit.test.js'] }
  ]
};

test('a substantial change is not started until the person says so', async () => {
  /*
     The plan is the cheapest moment to disagree: nothing has been written and
     nothing has been spent beyond the planning call. An agent that starts
     editing the moment it has an idea is one nobody can steer.
  */
  fresh('Done.', [callTool('write_file', { path: 'src/core/limit.js' })], PLAN);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result, events } = await run('add rate limiting to the login endpoint', {
    project, budget_micros: 5_000_000
  });

  assert.equal(result.status, 'waiting_for_approval');
  assert.equal(result.approval.kind, 'plan');
  assert.equal(result.approval.plan.steps.length, 3);
  assert.equal(result.approval.plan.done, 0);
  assert.deepEqual(result.changedFiles, [], 'a file was changed before anyone agreed to the plan');

  // The plan reaches the browser before the question does, so the card is
  // already on screen when it is asked.
  const types = events.map(event => event.type);
  assert.ok(types.indexOf('plan') < types.indexOf('approval'));
});

test('saying go runs the rest without asking again', async () => {
  fresh('Finished all three steps.', [], PLAN);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result } = await run('add rate limiting to the login endpoint', {
    project,
    budget_micros: 5_000_000,
    complexity: 'level2',
    plan: PLAN,
    run_state: { version: 1, planApproved: true, intent: 'code', level: 'level2', category: 'code', conversation: [], pendingCalls: [] }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Finished all three steps.');
});

test('a one-step change is not put to a vote', async () => {
  // Asking about everything is the same as asking about nothing: a
  // confirmation that always appears stops being read.
  fresh('Renamed it.', [], { summary: 'Rename the helper.', steps: [{ title: 'Rename it', files: ['src/util.js'] }] });

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result } = await run('rename the helper in src/util.js', { project, budget_micros: 5_000_000 });

  assert.equal(result.status, 'completed');
});

test('autopilot was the answer to that question', async () => {
  fresh('Done.', [], PLAN);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result } = await run('add rate limiting to the login endpoint', {
    project, mode: 'autopilot', budget_micros: 5_000_000
  });

  assert.equal(result.status, 'completed', 'autopilot stopped to ask permission it had already been given');
});

test('the agent can say how far it has got, and only when there is a plan', async () => {
  fresh('Step one is done.', [callTool('update_plan', { step: 1, status: 'done' })], PLAN);

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { result, events } = await run('add rate limiting to the login endpoint', {
    project,
    budget_micros: 5_000_000,
    complexity: 'level2',
    plan: PLAN,
    run_state: { version: 1, planApproved: true, intent: 'code', level: 'level2', category: 'code', conversation: [], pendingCalls: [] }
  });

  assert.equal(result.status, 'completed');

  const progress = events.filter(event => event.type === 'plan').at(-1);
  assert.equal(progress?.data.done, 1, 'the reported step did not reach the plan card');
  assert.equal(progress?.data.steps[0].status, 'done');
});

test('a task with no plan is not offered a way to report against one', async () => {
  fresh('It routes by category and level.');

  const project = { id: 'project-1', name: 'api', index_status: 'ready' };
  const { calls: made } = await run('what does the model router do in this project?', { project });

  const names = (turns(made).at(-1).tools || []).map(tool => tool.function?.name ?? tool.name);
  assert.ok(!names.includes('update_plan'));
});
