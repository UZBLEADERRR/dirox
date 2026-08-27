/**
 * What may run at the same time.
 *
 * The scheduler is deliberately narrow — only calls that cannot change
 * anything run together — so the tests worth writing are the ones that prove
 * it stays narrow, and that the model's ordering survives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planBatch, MAX_PARALLEL } from '../src/agent/parallel.js';

const call = (name, args = {}) => ({ id: `${name}-1`, name, arguments: args });

/** Flatten a plan back to the order the calls will actually run in. */
const order = groups => groups.flat().map(entry => entry.name);

test('reads that sit next to each other run together', async () => {
  const groups = await planBatch([
    call('read_file', { path: 'a.js' }),
    call('read_file', { path: 'b.js' }),
    call('search_code', { query: 'session' })
  ]);

  assert.equal(groups.length, 1, `three reads were split into ${groups.length} groups`);
  assert.equal(groups[0].length, 3);
});

test('a write runs alone, and everything keeps its place', async () => {
  const groups = await planBatch([
    call('read_file', { path: 'a.js' }),
    call('write_file', { path: 'a.js', content: 'x' }),
    call('read_file', { path: 'a.js' })
  ]);

  /*
     The second read is a read of the file the write just changed. Running it
     alongside the first would answer it with the old contents — which is why
     only *consecutive* read-only calls are grouped, rather than all of them.
  */
  assert.deepEqual(groups.map(group => group.length), [1, 1, 1]);
  assert.deepEqual(order(groups), ['read_file', 'write_file', 'read_file']);
});

test('risk is read from the arguments, not the tool name', async () => {
  // `supabase_execute` is a write when it inserts and destructive when it
  // migrates. Neither may run alongside anything, and the name alone cannot
  // say so.
  const groups = await planBatch([
    call('read_file', { path: 'a.js' }),
    call('supabase_execute', { sql: 'insert into users (id) values (1)' })
  ]);

  assert.deepEqual(groups.map(group => group.length), [1, 1]);
});

test('a command is never assumed to be safe', async () => {
  const groups = await planBatch([
    call('read_file', { path: 'a.js' }),
    call('execute_command', { command: 'rm -rf build' }),
    call('read_file', { path: 'b.js' })
  ]);

  assert.deepEqual(groups.map(group => group.length), [1, 1, 1]);
});

test('a sub-agent is never launched alongside anything', async () => {
  // An explorer cannot change a file, so risk alone would let two run at once.
  // Two whole agent runs sharing one budget object is a different feature.
  const groups = await planBatch([
    call('delegate', { role: 'explore', objective: 'find the router' }),
    call('delegate', { role: 'explore', objective: 'find the loader' })
  ]);

  assert.deepEqual(groups.map(group => group.length), [1, 1]);
});

test('a burst is capped rather than let loose on the provider', async () => {
  const reads = Array.from({ length: 11 }, (_, index) => call('read_file', { path: `f${index}.js` }));
  const groups = await planBatch(reads);

  for (const group of groups) {
    assert.ok(group.length <= MAX_PARALLEL, `a group of ${group.length} would be ${group.length} requests at once`);
  }
  assert.equal(groups.flat().length, 11, 'a call was dropped');
});

test('a tool nobody has heard of does not hold up the batch', async () => {
  // An unknown name never runs; it returns an error message. There is nothing
  // unsafe about producing that message alongside a read.
  const groups = await planBatch([
    call('read_file', { path: 'a.js' }),
    call('invented_tool')
  ]);

  assert.equal(groups.length, 1);
});

test('arguments that do not validate cannot smuggle a write into a group', async () => {
  const groups = await planBatch([
    call('read_file', { path: 'a.js' }),
    call('delete_file', {})          // missing its path, so it will be rejected
  ]);

  assert.deepEqual(groups.map(group => group.length), [1, 1]);
});

test('an empty turn plans to nothing', async () => {
  assert.deepEqual(await planBatch([]), []);
});
