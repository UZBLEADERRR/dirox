/**
 * SQL classification.
 *
 * This decides whether a statement runs silently or stops to ask, so getting
 * it wrong is expensive in both directions: too strict and every insert needs
 * a human; too loose and a `drop table` goes through unannounced. A migration
 * against someone's production database is the one mistake a checkpoint
 * cannot undo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatements } from '../src/agent/tools/supabase.js';
import { projectRef } from '../src/modules/projects/supabase.js';

test('reading is read-only', () => {
  for (const sql of [
    'select * from users',
    'SELECT id FROM orders WHERE total > 10',
    'with recent as (select 1) select * from recent',
    'explain analyze select 1'
  ]) {
    const shape = classifyStatements(sql);
    assert.equal(shape.readOnly, true, sql);
    assert.equal(shape.destructive, false, sql);
  }
});

test('changing rows is a write, not a schema change', () => {
  for (const sql of ['insert into users (id) values (1)', 'update users set name = $1', 'delete from sessions']) {
    const shape = classifyStatements(sql);
    assert.equal(shape.readOnly, false, sql);
    assert.equal(shape.destructive, false, `${sql} should not require approval`);
  }
});

test('changing the shape of the database asks first', () => {
  for (const sql of [
    'create table users (id uuid primary key)',
    'alter table users add column email text',
    'drop table users',
    'truncate orders',
    'grant select on users to anon'
  ]) {
    assert.equal(classifyStatements(sql).destructive, true, sql);
  }
});

test('a script is judged by every statement, not the first', () => {
  // This is how a drop would be smuggled past a check that reads one keyword.
  const shape = classifyStatements('select 1; drop table users;');
  assert.equal(shape.statements, 2);
  assert.equal(shape.readOnly, false);
  assert.equal(shape.destructive, true);
});

test('a comment is not a statement', () => {
  assert.equal(classifyStatements('-- drop table users\nselect 1').destructive, false,
    'a mention in a line comment must not force approval');
  assert.equal(classifyStatements('/* nothing */ drop table users').destructive, true,
    'a real statement after a block comment is still real');
});

test('something unrecognised is treated as dangerous', () => {
  // Not knowing what a statement does is a reason to ask, not to proceed.
  assert.equal(classifyStatements('do $$ begin perform 1; end $$').destructive, true);
  assert.equal(classifyStatements('vacuum full').destructive, true);
});

test('an empty script is not read-only by default', () => {
  const shape = classifyStatements('');
  assert.equal(shape.statements, 0);
  assert.equal(shape.readOnly, false, 'nothing to run is not the same as safe to run');
});

test('a project reference is read from the URL', () => {
  assert.equal(projectRef('https://abcdefgh.supabase.co'), 'abcdefgh');
  assert.equal(projectRef('https://abcdefgh.supabase.co/rest/v1'), 'abcdefgh');
  assert.equal(projectRef('https://example.com'), null);
  assert.equal(projectRef(''), null);
});
