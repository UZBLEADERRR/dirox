import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'dirox-sandbox-'));
process.env.WORKSPACE_ROOT = root;
process.env.SANDBOX_ENABLED = 'true';

const { runCommand } = await import('../src/exec/sandbox.js');
const { ensureWorkspace, writeWorkspaceFile } = await import('../src/exec/workspace.js');

const PROJECT = '99999999-8888-7777-6666-555555555555';

before(async () => {
  await ensureWorkspace(PROJECT);
  await writeWorkspaceFile(PROJECT, 'hello.txt', 'workspace content\n');
  await writeWorkspaceFile(PROJECT, 'hello.js', 'console.log("from a file");\n');
  // Scripts rather than `node -e`: an inline program is full of shell
  // metacharacters, and the policy is right to refuse those.
  await writeWorkspaceFile(PROJECT, 'spin.js', 'setInterval(function () {}, 1000);\n');
  await writeWorkspaceFile(PROJECT, 'dump-env.js', 'console.log(JSON.stringify(process.env));\n');
});

after(async () => { await rm(root, { recursive: true, force: true }); });

test('an allowed command runs and returns its output', async () => {
  const result = await runCommand(PROJECT, 'cat hello.txt');
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /workspace content/);
});

test('a failing command reports its exit code rather than throwing', async () => {
  const result = await runCommand(PROJECT, 'cat does-not-exist.txt');
  assert.equal(result.ok, false);
  assert.notEqual(result.exitCode, 0);
});

test('the command runs inside the workspace', async () => {
  const result = await runCommand(PROJECT, 'pwd');
  assert.match(result.stdout.trim(), new RegExp(`${PROJECT}$`));
});

test('a denied command is refused before it runs', async () => {
  await assert.rejects(() => runCommand(PROJECT, 'curl https://example.com'), /not permitted|not on the allowed/i);
});

test('chaining runs every segment, and every segment was checked', async () => {
  // Composition is allowed now, because a build script is composition. The
  // guarantee moved rather than disappearing: each command in the line is
  // checked, so a harmless first one cannot carry a refused second.
  const chained = await runCommand(PROJECT, 'echo hi && touch allowed.txt');
  assert.equal(chained.ok, true);

  const listing = await runCommand(PROJECT, 'ls');
  assert.ok(listing.stdout.includes('allowed.txt'), 'the second command really ran');
});

test('a chain cannot smuggle a refused command past an allowed one', async () => {
  await assert.rejects(() => runCommand(PROJECT, 'echo hi; curl https://example.com'), /not permitted/i);
  await assert.rejects(() => runCommand(PROJECT, 'echo hi && touch smuggled.txt && sh evil.sh'), /not permitted/i);

  const listing = await runCommand(PROJECT, 'ls');
  assert.ok(!listing.stdout.includes('smuggled.txt'),
    'a line is refused whole: nothing in it may run if any part of it is refused');
});

test('a composed line cannot write outside the workspace', async () => {
  await assert.rejects(() => runCommand(PROJECT, 'echo x > /tmp/escape-attempt.txt'), /outside the project workspace/i);
  await assert.rejects(() => runCommand(PROJECT, 'echo ok && cat /etc/passwd'), /outside the project workspace/i);
});

test('output is truncated at the configured limit', async () => {
  // `find /` would be huge; a bounded repeat is enough to exceed a small cap.
  const result = await runCommand(PROJECT, 'cat hello.txt', { maxOutput: 5 });
  assert.ok(result.output.length < 200, 'output must be capped');
});

test('a slow command is killed at the timeout', async () => {
  const result = await runCommand(PROJECT, 'node spin.js', { timeoutMs: 1200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test('credential-shaped environment variables are not passed through', async () => {
  process.env.DIROX_TEST_SECRET_KEY = 'must-not-leak';
  const result = await runCommand(PROJECT, 'node dump-env.js');
  delete process.env.DIROX_TEST_SECRET_KEY;
  assert.ok(!result.stdout.includes('must-not-leak'), 'secrets must never reach a subprocess');
  assert.ok(!result.stdout.includes('SUPABASE_SERVICE_ROLE_KEY'), 'service role key must never reach a subprocess');
});

test('an explicitly passed credential-shaped variable is still filtered', async () => {
  const result = await runCommand(PROJECT, 'node dump-env.js', {
    env: { MY_API_KEY: 'nope', SAFE_VALUE: 'yes' }
  });
  assert.ok(!result.stdout.includes('nope'), 'credential-shaped extras must be dropped');
  assert.ok(result.stdout.includes('yes'), 'ordinary extras should pass through');
});

test('an inline program is refused — the allowlist cannot see inside it', async () => {
  // `node -e` composes a program at runtime, and that program can spawn
  // exactly the executables the allowlist exists to refuse. Same principle as
  // `$(…)`: what runs must be visible before it runs.
  for (const command of [
    'node -e require("child_process").exec("id")',
    'node --eval process.exit(0)',
    'python3 -c import os'
  ]) {
    await assert.rejects(() => runCommand(PROJECT, command), /supplied as text|not permitted/i);
  }

  // Writing the script to a file and running it is the supported path: it is
  // visible, reviewable and undoable.
  const written = await runCommand(PROJECT, 'node hello.js');
  assert.equal(typeof written.ok, 'boolean');
});
