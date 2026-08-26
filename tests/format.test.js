/**
 * The client's formatters.
 *
 * They are pure and they run in the browser, but a wrong one is the kind of
 * fault nobody files a bug for — it just makes the product look careless.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCost, formatTokens, relativeTime, shortTime } from '../web/app/lib/format.js';

test('a cheap turn is not rounded away to nothing', () => {
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(26), '$0.000026', 'a 26 micro-dollar turn must not read as free');
  assert.equal(formatCost(1_200), '$0.0012');
  assert.equal(formatCost(24_000), '$0.024');
  assert.equal(formatCost(1_500_000), '$1.50');
  assert.equal(formatCost(24_000, { precise: true }), '$0.0240');
});

test('two days ago is days, not forty-eight hours', () => {
  const ago = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
  assert.match(relativeTime(ago(0.5)), /30 minutes/);
  assert.match(relativeTime(ago(2)), /2 hours/);
  assert.match(relativeTime(ago(48)), /2 days/);
  assert.match(relativeTime(ago(24 * 40)), /month/);
});

test('the compact form fits in a sidebar', () => {
  const ago = ms => new Date(Date.now() - ms).toISOString();
  assert.equal(shortTime(ago(10_000)), 'now');
  assert.equal(shortTime(ago(12 * 60_000)), '12m');
  assert.equal(shortTime(ago(2 * 3_600_000)), '2h');
  assert.equal(shortTime(ago(2 * 86_400_000)), '2d');
  assert.equal(shortTime(ago(3 * 604_800_000)), '3w');
  assert.equal(shortTime(ago(400 * 86_400_000)), '1y');
  assert.equal(shortTime(null), '');
});

test('token counts stay short enough to sit in a table cell', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(4_339), '4.3K');
  assert.equal(formatTokens(184_000), '184K');
  assert.equal(formatTokens(2_500_000), '2.5M');
});
