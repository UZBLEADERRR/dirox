import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, estimateTokens, estimateMessageTokens, microsToUsd, usdToMicros } from '../src/ai/pricing.js';

const model = {
  input_price_micros: 3_000_000,          // $3.00 per 1M input
  output_price_micros: 15_000_000,        // $15.00 per 1M output
  cached_input_price_micros: 300_000      // $0.30 per 1M cached
};

test('cost is computed from per-million prices', () => {
  // 1M input + 1M output = $3 + $15 = $18 = 18_000_000 micros
  assert.equal(costOf(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 18_000_000);
});

test('cached input is billed at the cached rate', () => {
  // 1M input of which 1M cached = $0.30
  assert.equal(costOf(model, { inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }), 300_000);
  // Half cached: $1.50 + $0.15 = $1.65
  assert.equal(costOf(model, { inputTokens: 1_000_000, cachedInputTokens: 500_000 }), 1_650_000);
});

test('cached tokens can never exceed input tokens', () => {
  const inflated = costOf(model, { inputTokens: 1000, cachedInputTokens: 999_999 });
  const honest = costOf(model, { inputTokens: 1000, cachedInputTokens: 1000 });
  assert.equal(inflated, honest);
});

test('reasoning tokens are billed at the output rate', () => {
  assert.equal(costOf(model, { outputTokens: 500_000, reasoningTokens: 500_000 }), 15_000_000);
});

test('cost rounds up so usage is never under-reported', () => {
  assert.equal(costOf(model, { inputTokens: 1 }), 3);
  assert.ok(costOf(model, { outputTokens: 1 }) >= 15);
});

test('a model without prices costs nothing rather than throwing', () => {
  assert.equal(costOf({ input_price_micros: 0, output_price_micros: 0 }, { inputTokens: 5000 }), 0);
  assert.equal(costOf(null, { inputTokens: 5000 }), 0);
});

test('token estimation is conservative for code', () => {
  const code = 'const handler = async (req, res) => { res.json({ ok: true }); };';
  const prose = 'This function handles the request and returns a JSON response to the caller.';
  // Code has denser punctuation, so it estimates more tokens per character.
  assert.ok(estimateTokens(code) / code.length > estimateTokens(prose) / prose.length);
  assert.equal(estimateTokens(''), 0);
});

test('message token estimation includes role overhead', () => {
  const withOverhead = estimateMessageTokens([{ role: 'user', content: 'hi' }]);
  assert.ok(withOverhead > estimateTokens('hi'));
});

test('image parts are counted, not ignored', () => {
  const textOnly = estimateMessageTokens([{ role: 'user', content: [{ type: 'text', text: 'look' }] }]);
  const withImage = estimateMessageTokens([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url' }] }]);
  assert.ok(withImage > textOnly + 500);
});

test('usd conversion round-trips', () => {
  assert.equal(microsToUsd(usdToMicros(0.014)), 0.014);
  assert.equal(usdToMicros(0.1), 100_000);
});
