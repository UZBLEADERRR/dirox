import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, PROFILES, parseIntent, shouldVerifyIntent } from '../src/agent/intent.js';
import { systemPrompt, volatileLayer, MINIMAL_POLICY } from '../src/agent/prompts.js';
import { toolsFor, toolDefinitions } from '../src/agent/tools/index.js';
import { assembleContext } from '../src/context/engine.js';
import { buildRequest } from '../src/ai/providers/anthropic.js';
import { estimateTokens, estimateMessageTokens } from '../src/ai/pricing.js';

const LIMITS = {
  contextTokens: 8000, outputTokens: 4000, maxFiles: 6, retrievalDepth: 12,
  historyMessages: 10, toolOutputChars: 6000, pressure: 'comfortable'
};

test('greetings and courtesy are chat, in any of the languages we serve', () => {
  for (const text of ['hi', 'Hello', 'Salom', 'assalomu alaykum', 'thanks', 'rahmat', 'ok', '👍']) {
    assert.equal(classifyIntent({ text, hasProject: true }).intent, 'chat', `"${text}"`);
  }
});

test('a request to change something is code, not chat', () => {
  for (const text of ['Add rate limiting to the login endpoint', 'fix the crash on refresh', 'refactor the router']) {
    assert.equal(classifyIntent({ text, hasProject: true }).intent, 'code', `"${text}"`);
  }
});

test('a question about the codebase is read-only', () => {
  const result = classifyIntent({ text: 'what does the model router do in this project?', hasProject: true });
  assert.equal(result.intent, 'ask');
  assert.equal(result.profile.toolset, 'read');
});

test('an explicit mode outranks the guess', () => {
  assert.equal(classifyIntent({ text: 'rewrite everything', mode: 'ask', hasProject: true }).intent, 'ask');
  assert.equal(classifyIntent({ text: 'hello', mode: 'edit', hasProject: true }).intent, 'code');
});

test('without a project nothing heavier than a question is possible', () => {
  const result = classifyIntent({ text: 'add a login page', hasProject: false });
  assert.notEqual(result.intent, 'code');
});

test('an unclear message defaults to read-only, never to writing', () => {
  const result = classifyIntent({ text: 'the thing near the bottom, that one', hasProject: true });
  assert.equal(result.intent, 'ask');
  assert.ok(result.confidence < 0.6);
});

test('verification is only worth paying for on an expensive guess', () => {
  assert.equal(shouldVerifyIntent({ intent: 'chat', confidence: 0.3 }), false);
  assert.equal(shouldVerifyIntent({ intent: 'ask', confidence: 0.45 }), true);
  assert.equal(shouldVerifyIntent({ intent: 'code', confidence: 0.9 }), false);
});

test('a malformed classifier reply falls back rather than throwing', () => {
  const fallback = classifyIntent({ text: 'anything', hasProject: true });
  assert.equal(parseIntent('not json at all', fallback), fallback);
  assert.equal(parseIntent('{"intent":"nonsense"}', fallback), fallback);
  assert.equal(parseIntent('{"intent":"chat"}', fallback).intent, 'chat');
});

test('the prompt tiers differ by an order of magnitude', () => {
  const minimal = estimateTokens(systemPrompt({ tier: 'minimal' }));
  const compact = estimateTokens(systemPrompt({ tier: 'compact', toolNames: ['read_file'] }));
  const full = estimateTokens(systemPrompt({ tier: 'full', mode: 'agent' }));

  assert.ok(minimal < 40, `minimal tier is ${minimal} tokens`);
  assert.ok(compact < 220, `compact tier is ${compact} tokens`);
  assert.ok(full > compact * 2, 'the full tier should be the expensive one');
});

test('the budget never enters the system prompt, because it changes every call', () => {
  const prompt = systemPrompt({ tier: 'full', mode: 'agent', project: { name: 'x' } });
  assert.ok(!/budget/i.test(prompt), 'a per-call value in the cached prefix invalidates the cache');
  assert.match(volatileLayer({ budget: '3 of 10 cents used', pressure: 'critical' }), /3 of 10 cents used/);
  assert.equal(volatileLayer({}), null);
});

test('a greeting sends no tools, no history, no files and no project context', async () => {
  const intent = classifyIntent({ text: 'Salom', hasProject: true });
  const tools = toolsFor({ mode: 'agent', toolset: intent.profile.toolset, hasRepository: true });
  const context = await assembleContext({
    objective: 'Salom', mode: 'agent', limits: LIMITS, profile: intent.profile,
    availableTools: tools, history: []
  });

  assert.equal(tools.length, 0, 'a greeting needs no tools');
  assert.equal(context.retrieval.files.length, 0);
  assert.equal(context.messages.filter(m => m.role === 'system').length, 1);
  assert.equal(context.messages[0].content, MINIMAL_POLICY);
  assert.equal(context.messages.length, 2, 'one system line and the message itself');
  assert.ok(context.tokens < 60, `a greeting cost ${context.tokens} tokens; the ceiling is 60`);
});

test('one pasted stack trace earlier in the conversation cannot make a greeting expensive', async () => {
  const context = await assembleContext({
    objective: 'rahmat', mode: 'agent', limits: LIMITS, profile: PROFILES.chat,
    history: Array.from({ length: 6 }, () => ({ role: 'user', content: 'x'.repeat(20_000) }))
  });
  assert.ok(context.tokens < 450, `a greeting after 120KB of history cost ${context.tokens} tokens`);
});

test('a question stays cheap, and a coding task is the only one that pays full price', async () => {
  const ask = classifyIntent({ text: 'what does the router do in this project?', hasProject: true });
  const code = classifyIntent({ text: 'Add rate limiting to the login endpoint', hasProject: true });

  const askTools = toolsFor({ mode: 'agent', toolset: ask.profile.toolset, hasRepository: true });
  const codeTools = toolsFor({ mode: 'agent', toolset: code.profile.toolset, hasRepository: true });

  const askCost = estimateTokens(JSON.stringify(toolDefinitions(askTools)));
  const codeCost = estimateTokens(JSON.stringify(toolDefinitions(codeTools)));

  assert.ok(askTools.length < codeTools.length);
  assert.ok(askCost < 600, `read tools cost ${askCost} tokens`);
  assert.ok(codeCost > askCost * 3, 'the full toolset is the expensive one');
});

test('the cache boundary sits at the end of the stable prefix, not after volatile context', () => {
  const model = { code: 'claude-3-5-haiku', max_output: 4096, supports_prompt_cache: true, supports_tools: true };
  const body = buildRequest({
    model,
    messages: [
      { role: 'system', content: 'stable policy', cacheBoundary: true },
      { role: 'system', content: 'repository content that changes every turn' },
      { role: 'user', content: 'go' }
    ],
    cacheSystem: true
  });

  assert.equal(body.system[0].cache_control?.type, 'ephemeral', 'the stable block is the cached one');
  assert.equal(body.system[1].cache_control, undefined, 'volatile content must stay out of the cached prefix');
});

test('a caller that marks no boundary keeps the old behaviour', () => {
  const model = { code: 'claude-3-5-haiku', max_output: 4096, supports_prompt_cache: true, supports_tools: true };
  const body = buildRequest({
    model,
    messages: [{ role: 'system', content: 'policy' }, { role: 'user', content: 'go' }],
    cacheSystem: true
  });
  assert.equal(body.system[0].cache_control?.type, 'ephemeral');
});

test('history is capped by the intent, not by the caller', async () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  const context = await assembleContext({
    objective: 'thanks', mode: 'agent', limits: LIMITS, profile: PROFILES.chat, history
  });
  const turns = context.messages.filter(m => m.role !== 'system').length;
  assert.ok(turns <= PROFILES.chat.historyTurns + 1, `${turns} turns survived a 4-turn cap`);
});

// ─── GitHub ─────────────────────────────────────────────────────────────────
//
// The GitHub tools are about 400 tokens of schema — most of a cheap question's
// budget — so they travel only when the message asks for them. Which makes
// "does this message mean GitHub?" a decision worth testing rather than
// trusting.

test('a message about GitHub is never small talk, however short', () => {
  for (const text of ['githubimni tekshir', 'github', 'check my github', 'repolarimni korsat']) {
    const result = classifyIntent({ text, hasProject: true });
    assert.notEqual(result.intent, 'chat', `"${text}" was treated as small talk`);
    assert.equal(result.profile.github, true, `"${text}" did not ask for the GitHub tools`);
  }
});

test('reading GitHub is a question; changing it is work', () => {
  assert.equal(classifyIntent({ text: 'list my pull requests', hasProject: true }).intent, 'ask');
  assert.equal(classifyIntent({ text: 'is CI green on main?', hasProject: true }).intent, 'ask');
  assert.equal(classifyIntent({ text: 'open a pull request for this branch', hasProject: true }).intent, 'code');
  assert.equal(classifyIntent({ text: 'merge the pull request', hasProject: true }).intent, 'code');
});

test('words that merely start like "repo" are not GitHub', () => {
  for (const text of ['report the results', 'reposition the header', 'repossess the build']) {
    assert.equal(classifyIntent({ text, hasProject: true }).profile.github, false, `"${text}"`);
  }
});

test('a plain question does not pay for the GitHub tools', () => {
  const plain = classifyIntent({ text: 'what does the model router do here?', hasProject: true });
  const github = classifyIntent({ text: 'what pull requests are open?', hasProject: true });

  const cost = profile => estimateTokens(JSON.stringify(toolDefinitions(
    toolsFor({ mode: 'agent', toolset: profile.toolset, hasRepository: true, includeGitHub: profile.github }))));

  assert.ok(cost(plain.profile) < 600, `a plain question costs ${cost(plain.profile)} tokens of schema`);
  assert.ok(cost(github.profile) > cost(plain.profile), 'a GitHub question should carry the GitHub tools');
});

test('the GitHub tools stay away from a user who has not connected one', () => {
  const names = toolsFor({ mode: 'agent', hasRepository: true, hasGitHub: false }).map(tool => tool.name);
  assert.ok(!names.some(name => name.startsWith('github_')),
    'a tool that can only answer "connect your account" costs schema and invites a wasted call');
});

test('opening a pull request always asks, whatever the trust level', async () => {
  const { githubTools } = await import('../src/agent/tools/github.js');
  const open = githubTools.find(tool => tool.name === 'github_open_pull_request');
  assert.equal(open.risk, 'outward', 'publishing to a shared repository is not a silent action');

  for (const tool of githubTools.filter(t => t.name !== 'github_open_pull_request')) {
    assert.equal(tool.risk, 'safe', `${tool.name} should be read-only`);
  }
});
