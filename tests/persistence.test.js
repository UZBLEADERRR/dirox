/**
 * Surviving the container.
 *
 * This is the scenario the feature exists for, run for real: write files into
 * a workspace, delete the directory the way a redeploy does, and get the work
 * back. Object storage is replaced by a map; everything between the tool call
 * and that map is the real code.
 *
 * Requires --experimental-test-module-mocks (see package.json).
 */

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).href;

/** The bucket, as a map. Keys are exactly what the real storage would hold. */
const objects = new Map();

let workspace;
let persistence;
let workspaceModule;

const PROJECT = '11111111-1111-4111-8111-111111111111';

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dirox-persist-'));
  process.env.WORKSPACE_ROOT = workspace;
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';

  mock.module(`${SRC}db/storage.js`, {
    namedExports: {
      PROJECT_BUCKET: 'project-files',
      hasStorage: () => true,
      ensureBucket: async () => true,
      async putObject(key, content) {
        objects.set(key, Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
        return { key, bytes: objects.get(key).length };
      },
      async getObject(key) { return objects.get(key) ?? null; },
      async deleteObject(key) { return objects.delete(key); },
      async listObjects(prefix) {
        return [...objects.keys()]
          .filter(key => key === prefix || key.startsWith(`${prefix}/`))
          .map(key => ({ key, size: objects.get(key).length }));
      },
      async deletePrefix(prefix) {
        let removed = 0;
        for (const key of [...objects.keys()]) {
          if (key === prefix || key.startsWith(`${prefix}/`)) { objects.delete(key); removed += 1; }
        }
        return removed;
      },
      encodeKey: key => key
    }
  });

  persistence = await import(`${SRC}exec/persistence.js`);
  workspaceModule = await import(`${SRC}exec/workspace.js`);
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** What a redeploy does: the container, and its disk, are replaced. */
async function replaceTheContainer() {
  await rm(join(workspace, PROJECT), { recursive: true, force: true });
  persistence.invalidate(PROJECT);
}

test('a file written by a tool is durable before the write returns', async () => {
  objects.clear();
  await workspaceModule.ensureWorkspace(PROJECT);
  await workspaceModule.writeWorkspaceFile(PROJECT, 'src/index.js', 'export const hello = 1;\n');

  assert.equal(objects.get(`${PROJECT}/src/index.js`)?.toString(), 'export const hello = 1;\n',
    'the write reported success, so it must already be recoverable');
});

test('work survives the container being replaced', async () => {
  objects.clear();
  persistence.invalidate(PROJECT);
  await workspaceModule.ensureWorkspace(PROJECT);

  await workspaceModule.writeWorkspaceFile(PROJECT, 'package.json', '{"name":"callorie"}');
  await workspaceModule.writeWorkspaceFile(PROJECT, 'src/app/main.js', 'run();');
  await workspaceModule.writeWorkspaceFile(PROJECT, 'README.md', '# Callorie');

  await replaceTheContainer();
  assert.equal(await readdir(join(workspace, PROJECT)).catch(() => null), null, 'the disk really is gone');

  const result = await persistence.materialiseWorkspace(PROJECT);
  assert.equal(result.restored, 3, `restored ${result.restored} of 3 files`);

  assert.equal(await readFile(join(workspace, PROJECT, 'package.json'), 'utf8'), '{"name":"callorie"}');
  assert.equal(await readFile(join(workspace, PROJECT, 'src/app/main.js'), 'utf8'), 'run();',
    'nested directories are recreated, not flattened');
  assert.equal(await readFile(join(workspace, PROJECT, 'README.md'), 'utf8'), '# Callorie');
});

test('an intact workspace is left alone', async () => {
  objects.clear();
  persistence.invalidate(PROJECT);
  await workspaceModule.ensureWorkspace(PROJECT);
  await workspaceModule.writeWorkspaceFile(PROJECT, 'keep.txt', 'local');

  // Storage disagrees with disk. Disk wins while it exists: it is the working
  // copy, and overwriting it would discard edits made since the last mirror.
  objects.set(`${PROJECT}/keep.txt`, Buffer.from('stale'));
  persistence.invalidate(PROJECT);

  const result = await persistence.materialiseWorkspace(PROJECT);
  assert.equal(result.restored, 0);
  assert.equal(await readFile(join(workspace, PROJECT, 'keep.txt'), 'utf8'), 'local');
});

test('deleting a file removes it from storage too', async () => {
  objects.clear();
  persistence.invalidate(PROJECT);
  await workspaceModule.ensureWorkspace(PROJECT);
  await workspaceModule.writeWorkspaceFile(PROJECT, 'temp.txt', 'x');
  assert.ok(objects.has(`${PROJECT}/temp.txt`));

  await workspaceModule.deleteWorkspacePath(PROJECT, 'temp.txt');
  assert.equal(objects.has(`${PROJECT}/temp.txt`), false,
    'a deleted file must not come back on the next restore');
});

test('deleting a directory removes everything under it', async () => {
  objects.clear();
  persistence.invalidate(PROJECT);
  await workspaceModule.ensureWorkspace(PROJECT);
  await workspaceModule.writeWorkspaceFile(PROJECT, 'old/a.js', 'a');
  await workspaceModule.writeWorkspaceFile(PROJECT, 'old/deep/b.js', 'b');
  await workspaceModule.writeWorkspaceFile(PROJECT, 'new/c.js', 'c');

  await workspaceModule.deleteWorkspacePath(PROJECT, 'old');

  assert.equal(objects.has(`${PROJECT}/old/a.js`), false);
  assert.equal(objects.has(`${PROJECT}/old/deep/b.js`), false);
  assert.equal(objects.has(`${PROJECT}/new/c.js`), true, 'a sibling directory is not collateral');
});

test('a move takes the file with it', async () => {
  objects.clear();
  persistence.invalidate(PROJECT);
  await workspaceModule.ensureWorkspace(PROJECT);
  await workspaceModule.writeWorkspaceFile(PROJECT, 'from.js', 'content');

  await workspaceModule.moveWorkspacePath(PROJECT, 'from.js', 'to.js');

  assert.equal(objects.has(`${PROJECT}/from.js`), false);
  assert.equal(objects.get(`${PROJECT}/to.js`)?.toString(), 'content');
});

test('what the terminal wrote is swept up by a snapshot', async () => {
  objects.clear();
  persistence.invalidate(PROJECT);
  const root = await workspaceModule.ensureWorkspace(PROJECT);

  // A subprocess cannot mirror itself, which is why a run snapshots at the end.
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(root, 'generated.ts'), 'export type X = 1;');
  await writeFile(join(root, 'dist', 'bundle.js'), 'built');
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'noise');

  const summary = await persistence.snapshotWorkspace(PROJECT);

  assert.ok(objects.has(`${PROJECT}/generated.ts`), 'source written by a subprocess must be captured');
  assert.equal(objects.has(`${PROJECT}/dist/bundle.js`), false, 'build output is derivative, not work');
  assert.equal(objects.has(`${PROJECT}/node_modules/left-pad/index.js`), false,
    'node_modules would turn a 40KB project into a 400MB one');
  assert.ok(summary.files >= 1);
});

test('credentials are never copied anywhere durable', () => {
  // The workspace refuses to write these at all; this is the second lock, on
  // the path that copies whatever is already on disk.
  for (const path of ['.env', 'config/.env.production', 'id_rsa', 'server.key', 'credentials.json']) {
    assert.equal(persistence.shouldPersist(path, 100), false, path);
  }
  for (const path of ['src/index.js', 'package.json', '.env.example']) {
    assert.equal(persistence.shouldPersist(path, 100), true, path);
  }
});

test('a large artefact is not mistaken for source', () => {
  assert.equal(persistence.shouldPersist('build/app.apk', 50 * 1024 * 1024), false);
  assert.equal(persistence.shouldPersist('src/index.js', 1024), true);
});

test('storage keys keep the path shape', () => {
  assert.equal(persistence.storageKey(PROJECT, 'src/a/b.js'), `${PROJECT}/src/a/b.js`);
  assert.equal(persistence.storageKey(PROJECT, '/leading.js'), `${PROJECT}/leading.js`);
});
