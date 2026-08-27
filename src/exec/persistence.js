/**
 * Making a workspace outlive its container.
 *
 * The workspace is a directory on local disk. On a platform that replaces the
 * container on every deploy — Railway, Fly, Heroku, any of them — that
 * directory is gone several times a week. For a project cloned from GitHub
 * that costs a re-clone. For a project created inside DiroxCode it costs
 * everything: the workspace was the only copy.
 *
 * So the workspace is treated as a cache of durable storage rather than as the
 * truth. Two rules keep that honest:
 *
 *   1. Anything the agent writes is mirrored to storage before the write is
 *      reported as done. A write that is not durable did not happen.
 *   2. Anything that reads the workspace materialises it first. A missing
 *      directory is a cache miss, not an error.
 *
 * Build output is deliberately not mirrored. `node_modules` is not work, it is
 * a derivative of `package.json`, and storing it would turn a 40KB project
 * into a 400MB one.
 */

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config/env.js';
import { hasStorage, putObject, getObject, deleteObject, listObjects, deletePrefix } from '../db/storage.js';
import { workspacePath, ensureWorkspace, IGNORED_DIRECTORIES, isSecretPath } from './workspace.js';
import { logger } from '../core/logger.js';

/** Larger than this is a build artefact by any reasonable reading. */
const MAX_PERSISTED_BYTES = 4 * 1024 * 1024;

/** Projects whose workspace has been materialised in this process. */
const materialised = new Map();

export function storageKey(projectId, path) {
  return `${projectId}/${String(path).replace(/^[/\\]+/, '')}`;
}

/**
 * Is this file part of the project, or a by-product of building it?
 *
 * The same question `IGNORED_DIRECTORIES` answers for indexing, asked again
 * here — a file nobody would put in version control does not belong in
 * durable storage either.
 */
export function shouldPersist(path, sizeBytes = 0) {
  const relative = String(path).replace(/^[/\\]+/, '');
  if (!relative) return false;
  if (sizeBytes > MAX_PERSISTED_BYTES) return false;
  // Credentials are never copied anywhere, least of all somewhere durable.
  if (isSecretPath(relative)) return false;
  return !relative.split('/').some(segment => IGNORED_DIRECTORIES.has(segment));
}

/**
 * Record a file. Called after every successful workspace write.
 *
 * Failures are logged and swallowed: a storage outage must not fail the edit
 * the user asked for. It costs durability for that one file, which the next
 * write of it repairs.
 */
export async function persistFile(projectId, path, content) {
  if (!hasStorage() || !projectId) return false;
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (!shouldPersist(path, body.length)) return false;

  try {
    await putObject(storageKey(projectId, path), body);
    return true;
  } catch (error) {
    logger.warn('could not persist a workspace file', { projectId, path, reason: error?.message });
    return false;
  }
}

export async function forgetFile(projectId, path) {
  if (!hasStorage() || !projectId) return false;
  try {
    return await deleteObject(storageKey(projectId, path));
  } catch (error) {
    logger.warn('could not remove a persisted file', { projectId, path, reason: error?.message });
    return false;
  }
}

/** Everything under a directory, for a recursive delete. */
export async function forgetTree(projectId, path) {
  if (!hasStorage() || !projectId) return 0;
  const prefix = storageKey(projectId, path).replace(/\/+$/, '');
  return deletePrefix(prefix).catch(error => {
    logger.warn('could not remove a persisted directory', { projectId, path, reason: error?.message });
    return 0;
  });
}

export async function forgetProject(projectId) {
  if (!hasStorage() || !projectId) return 0;
  return deletePrefix(`${projectId}`).catch(() => 0);
}

/**
 * Copy the whole workspace into storage.
 *
 * Run after a clone or an import, so a project has a durable copy from its
 * first moment rather than from its first edit.
 */
export async function snapshotWorkspace(projectId, { maxFiles = 5000 } = {}) {
  if (!hasStorage() || !projectId) return { files: 0, bytes: 0 };

  const root = workspacePath(projectId);
  let files = 0;
  let bytes = 0;

  const walk = async directory => {
    if (files >= maxFiles) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (files >= maxFiles) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const full = join(directory, entry.name);
      const relative = full.slice(root.length + 1).split(/[/\\]/).join('/');
      const info = await stat(full).catch(() => null);
      if (!info || !shouldPersist(relative, info.size)) continue;

      const content = await readFile(full).catch(() => null);
      if (!content) continue;
      if (await persistFile(projectId, relative, content)) { files += 1; bytes += content.length; }
    }
  };

  await walk(root).catch(error =>
    logger.warn('workspace snapshot incomplete', { projectId, reason: error?.message }));

  logger.info('workspace snapshotted', { projectId, files, bytes });
  materialised.set(projectId, Date.now());
  return { files, bytes };
}

/** Does this workspace hold anything? An empty directory counts as absent. */
async function workspaceHasFiles(projectId) {
  const entries = await readdir(workspacePath(projectId)).catch(() => null);
  if (!entries) return false;
  return entries.some(name => !name.startsWith('.tmp'));
}

/**
 * Rebuild a workspace from storage, if it needs rebuilding.
 *
 * Idempotent and cheap on the common path: a workspace that already has files
 * is left alone, and the answer is remembered for the life of the process.
 *
 * @returns {Promise<{restored:number, reason:string}>}
 */
export async function materialiseWorkspace(projectId) {
  if (!projectId) return { restored: 0, reason: 'no project' };
  if (materialised.has(projectId)) return { restored: 0, reason: 'already present' };

  if (await workspaceHasFiles(projectId)) {
    materialised.set(projectId, Date.now());
    return { restored: 0, reason: 'workspace intact' };
  }

  if (!hasStorage()) return { restored: 0, reason: 'no durable storage configured' };

  const objects = await listObjects(`${projectId}`).catch(error => {
    logger.warn('could not list persisted files', { projectId, reason: error?.message });
    return [];
  });

  if (!objects.length) return { restored: 0, reason: 'nothing stored' };

  const root = await ensureWorkspace(projectId);
  let restored = 0;

  // Sequential on purpose: a workspace rebuild is rare, and a hundred parallel
  // requests to storage is a good way to be rate limited during one.
  for (const object of objects) {
    const relative = object.key.slice(`${projectId}/`.length);
    if (!shouldPersist(relative, object.size)) continue;

    const content = await getObject(object.key).catch(() => null);
    if (!content) continue;

    const full = join(root, relative);
    await mkdir(dirname(full), { recursive: true }).catch(() => {});
    await writeFile(full, content).catch(error =>
      logger.warn('could not restore a file', { projectId, path: relative, reason: error?.message }));
    restored += 1;
  }

  materialised.set(projectId, Date.now());
  logger.info('workspace restored from durable storage', { projectId, restored });
  return { restored, reason: 'restored' };
}

/** Called when a workspace is deleted, so the next read rebuilds it. */
export function invalidate(projectId) { materialised.delete(projectId); }

export { MAX_PERSISTED_BYTES };
