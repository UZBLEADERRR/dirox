/**
 * Compressing a tool result.
 *
 * The saving is easy; not losing the thing that mattered is the hard part.
 * These tests are mostly about the second: a summariser that drops the stack
 * trace has not saved tokens, it has broken the agent and will cost more when
 * it flails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressResult, keepFailures, compressInstall, FLOOR } from '../src/agent/compress.js';

const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index)).join('\n');

test('a thousand lines of install become the four numbers anybody reads', () => {
  const output = [
    lines(40, () => 'npm WARN deprecated inflight@1.0.6'),
    lines(300, index => `Progress: ${index}%`),
    'added 143 packages, and audited 144 packages in 8s',
    'found 0 vulnerabilities'
  ].join('\n');

  const result = compressResult('install_dependency', { ok: true, output });

  assert.ok(result.to < result.from / 20, `only ${Math.round((1 - result.to / result.from) * 100)}% smaller`);
  assert.match(result.output, /143 package\(s\) added/);
  assert.match(result.output, /144 audited/);
  assert.match(result.output, /no vulnerabilities/);
});

test('a failure keeps every line that explains it', () => {
  // This is the one that must not regress. When something breaks, the detail
  // is the information.
  const output = [
    lines(80, index => `  ✓ passing ${index}`),
    '  ✗ auth › rejects an expired token',
    '    TypeError: Cannot read properties of undefined (reading "exp")',
    '        at verify (src/auth.js:42:18)',
    '',
    'Tests: 1 failed, 80 passed'
  ].join('\n');

  const result = compressResult('run_tests', { ok: false, output });

  assert.ok(result.compressed);
  assert.match(result.output, /rejects an expired token/, 'the failing test is named');
  assert.match(result.output, /TypeError: Cannot read properties/, 'the error survives');
  assert.match(result.output, /src\/auth\.js:42:18/, 'and the line that caused it');
  assert.match(result.output, /1 failed, 80 passed/, 'and the verdict');
  assert.ok(!result.output.includes('passing 12'), 'the eighty that worked are gone');
});

test('a passing run keeps its verdict', () => {
  const output = `${lines(120, index => `  ✓ case ${index} (2ms)`)}\n\nTests: 120 passed, 120 total`;
  const result = compressResult('run_tests', { ok: true, output });

  assert.ok(result.compressed);
  assert.match(result.output, /120 passed/, 'the answer to "did it work" must survive');
});

test('the model is told it is reading a summary', () => {
  // Otherwise it reasons about what is missing as though it were absent.
  const result = compressResult('execute_command', { ok: true, output: lines(400, index => `line ${index}`) });
  assert.match(result.output, /summarised/);
  assert.match(result.output, /if you need the rest/);
});

test('short output is left exactly alone', () => {
  for (const output of ['ok', 'Branch: main\nWorking tree is clean.', 'x'.repeat(FLOOR - 1)]) {
    const result = compressResult('execute_command', { ok: true, output });
    assert.equal(result.compressed, false);
    assert.equal(result.output, output, 'nothing is added to something already small');
  }
});

test('a file read is not treated as a log', () => {
  // Compressing source would make the agent edit code it has only half seen.
  const source = lines(200, index => `const value${index} = ${index};`);
  const result = compressResult('read_file', { ok: true, output: source });

  for (const probe of ['value0', 'value100', 'value199']) {
    assert.match(result.output, new RegExp(probe), `${probe} must still be there`);
  }
});

test('failure lines keep their neighbours', () => {
  // A stack trace is only useful with the line above it, and an assertion only
  // with the line below.
  const kept = keepFailures([
    'setting up',
    'context line before',
    'Error: boom',
    'context line after',
    'unrelated'
  ].join('\n'));

  assert.match(kept, /context line before/);
  assert.match(kept, /Error: boom/);
  assert.match(kept, /context line after/);
  assert.ok(!kept.includes('setting up'));
});

test('a gap says how much was skipped', () => {
  const kept = keepFailures([
    'Error: first',
    ...Array.from({ length: 20 }, (_, index) => `filler ${index}`),
    'Error: second'
  ].join('\n'));

  assert.match(kept, /… \d+ line\(s\)/, 'a jump must be visible, not silent');
});

test('output with nothing to summarise is not mangled', () => {
  assert.equal(compressInstall('nothing here at all'), null);
  const result = compressResult('install_dependency', { ok: true, output: lines(100, index => `unusual line ${index}`) });
  assert.match(result.output, /unusual line/, 'unrecognised output falls back to keeping it');
});

test('an empty failure still says something', () => {
  const result = compressResult('execute_command', { ok: false, output: `${' '.repeat(700)}` });
  assert.match(result.output, /failed|no output/);
});
