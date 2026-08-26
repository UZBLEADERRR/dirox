import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The workspace root is read from config at import time, so it is set first.
const root = await mkdtemp(join(tmpdir(), 'dirox-test-'));
process.env.WORKSPACE_ROOT = root;

const {
  resolveInside, readWorkspaceFile, writeWorkspaceFile, listWorkspace,
  isSecretPath, isTextFile, ensureWorkspace, workspacePath
} = await import('../src/exec/workspace.js');

const PROJECT = '11111111-2222-3333-4444-555555555555';

before(async () => {
  await ensureWorkspace(PROJECT);
  await writeWorkspaceFile(PROJECT, 'src/index.js', 'export const answer = 42;\n');
  await writeWorkspaceFile(PROJECT, 'README.md', '# Test project\n');
  await mkdir(join(root, 'outside'), { recursive: true });
  await writeFile(join(root, 'outside', 'secret.txt'), 'do not read me');
});

after(async () => { await rm(root, { recursive: true, force: true }); });

test('paths inside the workspace resolve', async () => {
  const resolved = await resolveInside(PROJECT, 'src/index.js');
  assert.ok(resolved.startsWith(workspacePath(PROJECT)));
});

test('traversal out of the workspace is refused', async () => {
  const attacks = [
    '../outside/secret.txt',
    '../../etc/passwd',
    'src/../../outside/secret.txt',
    './src/../../../etc/passwd',
    '/etc/passwd'
  ];
  for (const path of attacks) {
    // An absolute path is re-rooted; a relative traversal is rejected outright.
    const resolved = await resolveInside(PROJECT, path).catch(error => error);
    if (resolved instanceof Error) {
      assert.match(resolved.message, /outside the project workspace/i, `${path}: ${resolved.message}`);
    } else {
      assert.ok(resolved.startsWith(workspacePath(PROJECT)), `${path} escaped to ${resolved}`);
    }
  }
});

test('a symlink pointing out of the workspace is refused', async () => {
  await symlink(join(root, 'outside'), join(workspacePath(PROJECT), 'escape'), 'dir').catch(() => {});
  await assert.rejects(
    () => resolveInside(PROJECT, 'escape/secret.txt'),
    /outside the project workspace/i
  );
});

test('null bytes in a path are refused', async () => {
  await assert.rejects(() => resolveInside(PROJECT, 'src/\0index.js'), /invalid character/i);
});

test('credential files cannot be read by the agent', async () => {
  await writeFile(join(workspacePath(PROJECT), '.env'), 'SECRET=hunter2');
  await assert.rejects(() => readWorkspaceFile(PROJECT, '.env'), /credentials/i);
  // The same file is readable when a caller explicitly opts in, which only the
  // secret scanner does.
  const file = await readWorkspaceFile(PROJECT, '.env', { allowSecret: true });
  assert.match(file.content, /SECRET/);
});

test('credential files cannot be written', async () => {
  await assert.rejects(() => writeWorkspaceFile(PROJECT, '.env.production', 'X=1'), /not permitted/i);
  await assert.rejects(() => writeWorkspaceFile(PROJECT, 'certs/server.pem', 'x'), /not permitted/i);
});

test('secret path detection covers the common shapes', () => {
  for (const path of ['.env', '.env.local', 'id_rsa', 'certs/key.pem', 'service-account.json', '.npmrc']) {
    assert.equal(isSecretPath(path), true, `${path} should be treated as secret`);
  }
  for (const path of ['src/env.js', 'README.md', 'config/settings.json']) {
    assert.equal(isSecretPath(path), false, `${path} should not be treated as secret`);
  }
});

test('read and write round-trip, and report creation honestly', async () => {
  const created = await writeWorkspaceFile(PROJECT, 'src/new.ts', 'const x = 1;');
  assert.equal(created.created, true);
  const updated = await writeWorkspaceFile(PROJECT, 'src/new.ts', 'const x = 2;');
  assert.equal(updated.created, false);
  assert.notEqual(updated.hash, created.hash);
  const file = await readWorkspaceFile(PROJECT, 'src/new.ts');
  assert.equal(file.content, 'const x = 2;');
});

test('listing skips vendored directories and does not follow symlinks', async () => {
  await writeWorkspaceFile(PROJECT, 'node_modules/pkg/index.js', 'module.exports = {}');
  const { entries } = await listWorkspace(PROJECT);
  assert.ok(!entries.some(entry => entry.path.includes('node_modules')), 'node_modules must be skipped');
  assert.ok(!entries.some(entry => entry.path.startsWith('escape/')), 'symlinks must not be followed');
  assert.ok(entries.some(entry => entry.path === 'src/index.js'));
});

test('an invalid project id is refused before touching the filesystem', () => {
  assert.throws(() => workspacePath('../../etc'), /Invalid project identifier/);
  assert.throws(() => workspacePath('not-a-uuid'), /Invalid project identifier/);
});

test('text file detection covers extensionless conventions', () => {
  assert.equal(isTextFile('src/index.ts'), true);
  assert.equal(isTextFile('Dockerfile'), true);
  assert.equal(isTextFile('Makefile'), true);
  assert.equal(isTextFile('image.png'), false);
});
