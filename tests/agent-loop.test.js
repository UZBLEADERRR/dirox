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

const MODEL = {
  id: 'model-1', code: 'test/haiku', name: 'Test Haiku', max_output: 8192,
  supports_tools: true, supports_prompt_cache: true, supports_vision: false,
  input_price_micros: 800, output_price_micros: 4000, context_window: 200_000,
  tiers: ['level0', 'level1', 'level2'], user_selectable: true
};

// Mocks are installed once: a module cannot be mocked twice in one process.
{
  mock.module(`${SRC}ai/gateway.js`, {
    namedExports: {
      async complete(request) {
        calls.push(request);
        return {
          text: reply,
          toolCalls: [],
          usage: { inputTokens: 30, outputTokens: 12, cachedInputTokens: 0 },
          costMicros: 24,
          finishReason: 'stop',
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
function fresh(answer) {
  calls = [];
  reply = answer;
}

/** Run one objective through the real loop and report what the model saw. */
async function run(objective, { mode = 'agent', project = null } = {}) {
  const { runTask } = await import(`${SRC}agent/orchestrator.js`);
  const events = [];

  const result = await runTask(
    {
      id: 'task-1', objective, mode, title: objective.slice(0, 40),
      budget_micros: 100_000, spent_micros: 0, iterations: 0,
      conversation_id: null, max_iterations: 4
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

  const modelCall = made.at(-1);
  assert.ok(modelCall.tools?.length > 10, `a coding task was sent ${modelCall.tools?.length ?? 0} tools`);
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
