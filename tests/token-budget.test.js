/**
 * What a run costs.
 *
 * The product is billed per token, so these are not style tests: each one
 * guards a measured number, and a regression shows up as a failing assertion
 * rather than as a larger invoice at the end of the month.
 *
 * The measurement that produced them: a sixteen-step coding run cost 150,744
 * input tokens, of which 75,776 were tool schemas re-sent identically on every
 * call — for forty-one tools that were never used once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsFor, toolDefinitions, availableGroups } from '../src/agent/tools/index.js';
import { estimateTokens, estimateMessageTokens } from '../src/ai/pricing.js';
import { compressHistory, digestToolOutput, markSettledPrefix, assembleContext } from '../src/context/engine.js';
import { CORE_TOOLS, TOOL_GROUPS, groupsFor } from '../src/agent/tools/groups.js';
import { buildRequest } from '../src/ai/providers/anthropic.js';
import { PROFILES } from '../src/agent/intent.js';

const EVERYTHING = { mode: 'agent', hasRepository: true, hasGitHub: true, hasSupabase: true, hasDevCommand: true };
const cost = tools => estimateTokens(JSON.stringify(toolDefinitions(tools)));

// ─── what travels ───────────────────────────────────────────────────────────

test('a coding task carries the core, not the catalogue', () => {
  const core = toolsFor(EVERYTHING);
  const all = toolsFor({ ...EVERYTHING, loadedGroups: new Set(Object.keys(TOOL_GROUPS)) });

  assert.ok(cost(core) < 2000, `the core costs ${cost(core)} tokens`);
  assert.ok(cost(all) > cost(core) * 2.5, 'the catalogue is what we are not sending');
  assert.equal(core.length, CORE_TOOLS.length);
});

test('the core can read, change, search and run without asking', () => {
  // If it could not, the model would spend a round trip on the second step of
  // every task and the saving would be imaginary.
  const names = toolsFor(EVERYTHING).map(tool => tool.name);
  for (const required of ['read_file', 'write_file', 'edit_file', 'search_code', 'find_symbol', 'list_directory', 'execute_command', 'run_tests']) {
    assert.ok(names.includes(required), `${required} must not need loading`);
  }
  assert.ok(names.includes('load_tools'), 'and everything else must be reachable');
});

test('loading a group makes exactly that group available', () => {
  const before = new Set(toolsFor(EVERYTHING).map(tool => tool.name));
  const after = new Set(toolsFor({ ...EVERYTHING, loadedGroups: new Set(['github']) }).map(tool => tool.name));

  for (const name of TOOL_GROUPS.github.tools) {
    assert.equal(before.has(name), false, `${name} should start deferred`);
    assert.equal(after.has(name), true, `${name} should arrive with its group`);
  }
  for (const name of TOOL_GROUPS.database.tools) {
    assert.equal(after.has(name), false, 'loading one group must not load another');
  }
});

test('a group nobody can use is not offered', () => {
  // Offering GitHub to an account with no GitHub connection costs a wasted
  // call to discover it does not exist.
  const groups = availableGroups({ ...EVERYTHING, hasGitHub: false, hasSupabase: false });
  assert.equal(groups.has('github'), false);
  assert.equal(groups.has('database'), false);
  assert.equal(groups.has('git'), true);
});

test('the objective loads what it obviously needs', () => {
  assert.deepEqual(groupsFor('open a pull request for this branch').sort(), ['git', 'github']);
  assert.ok(groupsFor('add a users table migration').includes('database'));
  assert.ok(groupsFor('send me the project as a zip').includes('delivery'));
  assert.deepEqual(groupsFor('rename the helper in src/util.js'), [], 'an ordinary edit loads nothing');
});

test('a named toolset is fixed, and carries no loader', () => {
  // A read-only question must not be able to widen its own reach.
  const names = toolsFor({ ...EVERYTHING, toolset: 'read' }).map(tool => tool.name);
  assert.ok(!names.includes('load_tools'));
  assert.equal(toolsFor({ ...EVERYTHING, toolset: 'none' }).length, 0);
});

// ─── what is remembered ─────────────────────────────────────────────────────

test('an old tool result becomes a line, not a file', () => {
  const body = `first line\n${'x'.repeat(4000)}\nlast line`;
  const digest = digestToolOutput(body);

  assert.ok(digest.length < 250, `the digest is ${digest.length} characters`);
  assert.match(digest, /first line/, 'it still says what it was');
  assert.match(digest, /read again/, 'and how to get the body back');
});

test('recent tool results stay verbatim; older ones do not', () => {
  const history = [];
  for (let index = 0; index < 6; index += 1) {
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${index}` }] });
    history.push({ role: 'tool', tool_call_id: `t${index}`, name: 'read_file', content: `body ${index}\n${'y'.repeat(3000)}` });
  }

  const compressed = compressHistory(history, { keepRecent: 20, verbatimToolResults: 2 });
  const results = compressed.filter(turn => turn.role === 'tool');

  assert.equal(results.length, 6, 'every result is still present');
  assert.ok(results.at(-1).content.length > 2000, 'the newest is what the model is working from');
  assert.ok(results[0].content.length < 250, 'the oldest is a line');
});

test('a tool result stays a tool result', () => {
  // It used to be flattened into an anonymous user message, which left the
  // model unable to tell which call produced which output.
  const compressed = compressHistory([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: 'contents' }
  ], { keepRecent: 10 });

  assert.equal(compressed[0].role, 'assistant');
  assert.equal(compressed[0].tool_calls?.[0]?.id, 'call-1', 'the call survives compression');
  assert.equal(compressed[1].role, 'tool');
  assert.equal(compressed[1].tool_call_id, 'call-1', 'and stays paired with its result');
});

// ─── what is cached ─────────────────────────────────────────────────────────

test('the settled part of a conversation gets a cache breakpoint', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `turn ${index}`
  }));

  const index = markSettledPrefix(messages);
  assert.ok(index !== null && index > 0, 'a long conversation has a settled prefix');
  assert.ok(index <= messages.length - 6, 'the recent turns are not claimed as settled');
  assert.equal(messages[index].cacheBoundary, true);
});

test('the breakpoint moves in strides, so a write buys several reads', () => {
  // Moving it every call means paying the write premium every call.
  const at = length => markSettledPrefix(
    Array.from({ length }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x' })));

  // Constant within a stride, and only then a step.
  assert.equal(at(10), at(11), 'one more message must not move the boundary');
  assert.equal(at(11), at(13));
  assert.ok(at(14) > at(13), 'and it steps once per stride, not once per call');
  assert.equal(at(14), at(17));
  assert.ok(at(18) > at(17));
});

test('a short conversation is not worth a breakpoint', () => {
  assert.equal(markSettledPrefix([{ role: 'user', content: 'hi' }]), null);
});

test('the boundary reaches the provider', () => {
  const model = { code: 'claude', max_output: 4096, supports_prompt_cache: true, supports_tools: true };
  const body = buildRequest({
    model,
    messages: [
      { role: 'system', content: 'policy', cacheBoundary: true },
      { role: 'user', content: 'settled', cacheBoundary: true },
      { role: 'assistant', content: 'recent' }
    ],
    cacheSystem: true
  });

  assert.equal(body.system[0].cache_control?.type, 'ephemeral');
  assert.equal(body.messages[0].content.at(-1).cache_control?.type, 'ephemeral',
    'the settled conversation prefix is cached too');
  assert.equal(body.messages[1].cache_control, undefined, 'the recent turn is not');
  assert.ok(!('cacheBoundary' in body.messages[0]), 'the marker is ours, not the API\'s');
});

// ─── the number that matters ────────────────────────────────────────────────

test('a sixteen-step run stays under the measured ceiling', async () => {
  const limits = { contextTokens: 8000, outputTokens: 4000, maxFiles: 6, retrievalDepth: 12,
                   historyMessages: 10, toolOutputChars: 6000, pressure: 'comfortable' };
  const history = [];
  const tools = toolsFor({ ...EVERYTHING, loadedGroups: new Set(['git']) });
  const schema = cost(tools);
  let total = 0;

  for (let step = 1; step <= 16; step += 1) {
    const context = await assembleContext({
      objective: 'Add rate limiting to the login endpoint', mode: 'agent', limits,
      profile: PROFILES.code, history, availableTools: tools
    });
    total += context.tokens + schema;

    history.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${step}` }] });
    history.push({ role: 'tool', tool_call_id: `t${step}`, name: 'read_file', content: `line one\n${'x'.repeat(3000)}\nlast line` });
  }

  // It was 150,744 before this work. The ceiling has headroom for ordinary
  // drift and none for going back.
  assert.ok(total < 95_000, `a sixteen-step run cost ${total.toLocaleString()} input tokens`);
});
