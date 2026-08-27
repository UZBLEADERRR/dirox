/**
 * What survives an interruption.
 *
 * The claims worth testing here are not "it round-trips" — that is obvious —
 * but the two that decide whether a resumed run works at all: a tool result
 * must never outlive the call that produced it, and a state that cannot be
 * trusted must come back as nothing rather than as something plausible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  packRunState, unpackRunState, trimConversation, packMessage, KEEP_MESSAGES, MESSAGE_CHARS
} from '../src/agent/runstate.js';

/** A run state as the orchestrator holds it. */
function state(overrides = {}) {
  return {
    stepIndex: 12,
    escalations: 1,
    checkpointId: 'checkpoint-1',
    loadedGroups: new Set(['github', 'build']),
    changedFiles: new Map([['src/a.js', { path: 'src/a.js', kind: 'modified' }]]),
    deliverables: [{ name: 'report.pdf' }],
    recentActions: ['read_file:{"path":"src/a.js"}'],
    conversation: [{ role: 'assistant', content: 'Working on it.' }],
    ...overrides
  };
}

test('a run comes back with everything it would need to continue', () => {
  const packed = packRunState(state(), {
    iteration: 9, category: 'code', level: 'level2', intent: 'code', finalText: 'halfway'
  });
  const back = unpackRunState(packed);

  assert.equal(back.iteration, 9);
  assert.equal(back.stepIndex, 12);
  assert.equal(back.level, 'level2');
  assert.equal(back.intent, 'code');
  assert.equal(back.checkpointId, 'checkpoint-1');
  assert.deepEqual(back.loadedGroups.sort(), ['build', 'github']);
  assert.deepEqual(back.changedFiles, [{ path: 'src/a.js', kind: 'modified' }]);
  assert.equal(back.conversation.length, 1);
});

test('the calls that never ran are remembered, and only those', () => {
  const packed = packRunState(state(), {
    iteration: 3,
    pendingCalls: [
      { id: 'call-1', name: 'execute_command', arguments: { command: 'rm -rf build' } },
      { id: 'call-2', name: 'run_tests', arguments: {} }
    ]
  });

  const back = unpackRunState(packed);
  assert.equal(back.pendingCalls.length, 2);
  assert.equal(back.pendingCalls[0].name, 'execute_command');
  assert.equal(back.pendingCalls[0].arguments.command, 'rm -rf build');
});

test('a tool result never outlives the call that asked for it', () => {
  /*
     This is the bug the trim exists for. A window that begins in the middle of
     a tool round leaves results whose assistant turn is gone, and every
     provider rejects that outright — OpenAI with an error naming the orphaned
     tool_call_id, which is a confusing way to learn that a run was trimmed.
  */
  const conversation = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', name: 'read_file', content: 'contents' },
    { role: 'tool', tool_call_id: 'b', name: 'read_file', content: 'more' },
    { role: 'assistant', content: 'done' }
  ];

  const trimmed = trimConversation(conversation, 3);
  assert.equal(trimmed[0].role, 'assistant', `the window opened on a ${trimmed[0].role} message`);
  assert.ok(!trimmed.some((message, index) => message.role === 'tool' && index === 0));
});

test('a conversation that is all tool results trims to nothing rather than to nonsense', () => {
  const trimmed = trimConversation([
    { role: 'tool', tool_call_id: 'a', content: 'x' },
    { role: 'tool', tool_call_id: 'b', content: 'y' }
  ], 2);
  assert.equal(trimmed.length, 0);
});

test('which call produced which result survives being written down', () => {
  const packed = packMessage({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call-9', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a.js"}' } }]
  });

  assert.equal(packed.tool_calls[0].id, 'call-9');
  assert.equal(packed.tool_calls[0].function.name, 'edit_file');
  assert.equal(packed.tool_calls[0].function.arguments, '{"path":"a.js"}');
});

test('a long run does not write a growing blob on every step', () => {
  const conversation = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(20_000)
  }));

  const packed = packRunState(state({ conversation }), { iteration: 200 });
  assert.ok(packed.conversation.length <= KEEP_MESSAGES, `${packed.conversation.length} messages were stored`);
  for (const message of packed.conversation) {
    assert.ok(message.content.length <= MESSAGE_CHARS, `a message of ${message.content.length} characters was stored whole`);
  }

  const size = JSON.stringify(packed).length;
  assert.ok(size < 100_000, `the stored state is ${size.toLocaleString()} characters`);
});

test('there is nothing to resume from an empty column', () => {
  assert.equal(unpackRunState(null), null);
  assert.equal(unpackRunState({}), null);
  assert.equal(unpackRunState({ version: 1, conversation: [], pendingCalls: [] }), null);
});

test('a state written by a different version is not guessed at', () => {
  const packed = packRunState(state(), { iteration: 4 });
  assert.equal(unpackRunState({ ...packed, version: 99 }), null);
});

test('junk in the stored state does not reach the loop', () => {
  const back = unpackRunState({
    version: 1,
    conversation: [{ role: 'assistant', content: 'ok' }, null, 'nonsense', { content: 'no role' }],
    changedFiles: [{ path: 'a.js' }, null, { kind: 'modified' }],
    loadedGroups: ['github', 42, null],
    pendingCalls: [{ id: 'x', name: 'read_file' }, { id: 'y' }]
  });

  assert.equal(back.conversation.length, 1);
  assert.deepEqual(back.changedFiles, [{ path: 'a.js' }]);
  assert.deepEqual(back.loadedGroups, ['github']);
  assert.equal(back.pendingCalls.length, 1);
});
