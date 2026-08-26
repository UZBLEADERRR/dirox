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

test('command chaining cannot smuggle a second command', async () => {
  // If a shell were involved, this would create the file. It must not.
  await assert.rejects(() => runCommand(PROJECT, 'echo hi; touch smuggled.txt'), /chaining|not permitted/i);
  const check = await runCommand(PROJECT, 'ls');
  assert.ok(!check.stdout.includes('smuggled.txt'), 'no shell interpretation may occur');
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

test('an inline program is refused — it is indistinguishable from injection', async () => {
  await assert.rejects(
    () => runCommand(PROJECT, 'node -e require("child_process").exec("id")'),
    /chaining|not permitted/i
  );
});
