import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseClassification, LEVELS, levelIndex } from '../src/ai/router.js';
import { preferenceAllowed } from '../src/ai/catalog.js';

test('greetings route to the cheapest tier', () => {
  for (const text of ['hi', 'hello', 'thanks', 'ok']) {
    assert.equal(classify({ text }).level, 'level0', `"${text}" should be level0`);
  }
});

test('a simple edit does not reach for a strong model', () => {
  const result = classify({ text: 'Fix the typo in the login button label' });
  assert.ok(levelIndex(result.level) <= 2, `expected a cheap tier, got ${result.level}`);
  assert.equal(result.category, 'code');
});

test('architecture requests classify high', () => {
  const result = classify({ text: 'Redesign the architecture so the ingestion pipeline scales to 100k events per second' });
  assert.ok(levelIndex(result.level) >= 3, `expected level3+, got ${result.level}`);
  assert.equal(result.category, 'architecture');
});

test('a stack trace is treated as debugging', () => {
  const result = classify({ text: 'TypeError: Cannot read property id of undefined at getUser (auth.ts:42)', hasError: true });
  assert.equal(result.category, 'debug');
});

test('security review classifies as review at a strong tier', () => {
  const result = classify({ text: 'Run a security audit of the payment module and report vulnerabilities' });
  assert.equal(result.category, 'review');
  assert.ok(levelIndex(result.level) >= 3);
});

test('more files in scope raises the level', () => {
  const few = classify({ text: 'Rename the user service methods', fileCount: 2 });
  const many = classify({ text: 'Rename the user service methods', fileCount: 40 });
  assert.ok(levelIndex(many.level) > levelIndex(few.level));
});

test('the level never exceeds the defined ladder', () => {
  const result = classify({ text: 'Redesign the distributed architecture for concurrency and scalability. '.repeat(40), fileCount: 500 });
  assert.ok(LEVELS.includes(result.level));
  assert.equal(result.level, 'level4');
});

test('confidence is lower when nothing matched', () => {
  const vague = classify({ text: 'Could you take a look at the thing we discussed and handle it appropriately please' });
  const clear = classify({ text: 'hi' });
  assert.ok(vague.confidence < clear.confidence);
});

test('model classification is parsed, and garbage falls back', () => {
  const fallback = { level: 'level1', category: 'chat', confidence: 0.5, reasons: [] };
  assert.equal(parseClassification('{"level":"level3","category":"code"}', fallback).level, 'level3');
  assert.equal(parseClassification('not json at all', fallback).level, 'level1');
  // An invalid level is rejected rather than trusted.
  assert.equal(parseClassification('{"level":"level99","category":"code"}', fallback).level, 'level1');
});

// ─── model access ───────────────────────────────────────────────────────────
//
// `enabled` and `user_selectable` answer different questions, and letting a
// client's preference bypass the second is how a closed model gets used.

const openModel = {
  id: 'm-open', user_selectable: true, tiers: ['level1', 'level2'],
  supports_tools: true, supports_vision: false
};
const closedModel = { ...openModel, id: 'm-closed', user_selectable: false };

test('a preference is honoured only for a model an administrator opened', () => {
  assert.equal(preferenceAllowed(openModel), true);
  assert.equal(preferenceAllowed(closedModel), false, 'a closed model must not be reachable by asking for it');
  assert.equal(preferenceAllowed(null), false);
  assert.equal(preferenceAllowed({ ...openModel, user_selectable: undefined }), false, 'absent must mean closed');
});

test('an open model still has to fit the plan and the request', () => {
  assert.equal(preferenceAllowed(openModel, { allowedTiers: ['level0'] }), false, 'outside the plan tiers');
  assert.equal(preferenceAllowed(openModel, { allowedTiers: ['level0', 'level1'] }), true);
  assert.equal(preferenceAllowed(openModel, { requireVision: true }), false, 'cannot see images');
  assert.equal(preferenceAllowed(openModel, { requireTools: true }), true);
  assert.equal(preferenceAllowed({ ...openModel, supports_tools: false }, { requireTools: true }), false);
});

test('an empty tier list means the plan does not narrow anything', () => {
  assert.equal(preferenceAllowed(openModel, { allowedTiers: [] }), true);
});
