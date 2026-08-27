/**
 * The brief a run starts from.
 *
 * The claim is that this replaces an iteration: everything the agent would
 * otherwise have spent its first step discovering is here, and it is here
 * without a model having been asked anything. So the tests check both halves —
 * that the facts are actually in it, and that it stays small enough to be
 * cheaper than the step it replaces.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The workspace root is read from config at import time, so it is set first.
const root = await mkdtemp(join(tmpdir(), 'dirox-orient-'));
process.env.WORKSPACE_ROOT = root;

const { ensureWorkspace, writeWorkspaceFile } = await import('../src/exec/workspace.js');
const { orientation } = await import('../src/agent/orientation.js');
const { estimateTokens } = await import('../src/ai/pricing.js');

const PROJECT = '11111111-2222-3333-4444-666666666666';
const EMPTY = '11111111-2222-3333-4444-777777777777';

before(async () => {
  await ensureWorkspace(PROJECT);
  await writeWorkspaceFile(PROJECT, 'package.json', JSON.stringify({
    name: 'checkout',
    scripts: { test: 'node --test', build: 'node build.js', dev: 'node server.js' },
    dependencies: { express: '^4.0.0' }
  }, null, 2));
  await writeWorkspaceFile(PROJECT, 'README.md', '# checkout\n');
  await writeWorkspaceFile(PROJECT, 'Dockerfile', 'FROM node:20\n');
  for (const path of ['src/index.js', 'src/routes/pay.js', 'src/routes/refund.js', 'src/lib/money.js']) {
    await writeWorkspaceFile(PROJECT, path, 'export const x = 1;\n');
  }
  await writeWorkspaceFile(PROJECT, 'tests/pay.test.js', 'import "node:test";\n');
  await ensureWorkspace(EMPTY);
});

after(() => rm(root, { recursive: true, force: true }));

test('the brief carries what the first step would have gone looking for', async () => {
  const brief = await orientation(PROJECT);
  assert.ok(brief, 'no brief was produced for a real project');

  // The language and the commands: what `inspect_project` would have returned.
  assert.match(brief, /JavaScript/i);
  assert.match(brief, /test: npm run test/);
  assert.match(brief, /build: npm run build/);

  // The shape of the repository: what a directory listing would have shown.
  assert.match(brief, /src\/ \(4\)/);
  assert.match(brief, /tests\/ \(1\)/);

  // The files a person looks for first.
  assert.match(brief, /package\.json/);
  assert.match(brief, /Dockerfile/);
  assert.match(brief, /README\.md/);
});

test('the brief is cheaper than the step it replaces', async () => {
  const brief = await orientation(PROJECT);
  const tokens = estimateTokens(brief);

  // A skipped iteration is a model call carrying the system prompt, every tool
  // schema and the whole conversation, plus a tool round trip — thousands of
  // tokens. This has to stay in the hundreds for the trade to hold.
  assert.ok(tokens < 400, `the brief costs ${tokens} tokens; it is meant to be a few hundred`);
});

test('the brief says where it came from', async () => {
  // A model that takes this for something it worked out itself will not
  // re-check the things it should re-check.
  const brief = await orientation(PROJECT);
  assert.match(brief, /established before this run started/i);
});

test('an empty workspace produces nothing rather than an empty heading', async () => {
  assert.equal(await orientation(EMPTY), null);
});

test('there is no brief without a project', async () => {
  assert.equal(await orientation(null), null);
  assert.equal(await orientation(''), null);
});

test('a workspace that cannot be read does not fail the run', async () => {
  // Orientation is a convenience. A run must not die because a project id is
  // not one, which is the shape every unreadable workspace arrives in.
  await assert.doesNotReject(() => orientation('not-a-uuid'));
  assert.equal(await orientation('not-a-uuid'), null);
});
