/**
 * Project lifecycle: create, import, index, archive, delete.
 *
 * The heavy parts (cloning, extracting, indexing) run as queued jobs so an
 * HTTP request never waits on them.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { serviceClient } from '../../db/supabase.js';
import { AppError, badRequest, notFound, payloadTooLarge, upstreamFailed } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { enqueue, QUEUES } from '../../queue/queue.js';
import { ensureWorkspace, workspacePath, removeWorkspace, workspaceSize } from '../../exec/workspace.js';
import { snapshotWorkspace, forgetProject, invalidate } from '../../exec/persistence.js';
import { indexProject } from '../../context/indexer.js';
import { downloadTarball, repositoryToken, storeRepositoryToken } from './github.js';
import { registerHandler } from '../../queue/worker.js';
import { notify } from '../notifications/routes.js';

const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;

export function slugifyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
}

/** Ensure `slug` is unique inside the organization. */
export async function uniqueSlug(db, orgId, base) {
  const slug = slugifyName(base);
  const existing = await db.from('projects').select('slug').eq('org_id', orgId).like('slug', slug).limit(50).all();
  const taken = new Set(existing.map(row => row.slug));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 100; i += 1) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
  return `${slug}-${Date.now().toString(36)}`;
}

export function shapeProject(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    language: row.language,
    framework: row.framework,
    packageManager: row.package_manager,
    testCommand: row.test_command,
    buildCommand: row.build_command,
    devCommand: row.dev_command,
    deployCommand: row.deploy_command,
    status: row.status,
    indexStatus: row.index_status,
    indexError: row.index_error,
    indexedAt: row.indexed_at,
    fileCount: row.file_count,
    symbolCount: row.symbol_count,
    sizeBytes: Number(row.size_bytes || 0),
    health: row.health,
    settings: row.settings,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    repository: row.repositories
      ? {
          id: row.repositories.id,
          provider: row.repositories.provider,
          fullName: row.repositories.full_name,
          owner: row.repositories.owner,
          name: row.repositories.name,
          htmlUrl: row.repositories.html_url,
          defaultBranch: row.repositories.default_branch,
          visibility: row.repositories.visibility,
          lastSyncedAt: row.repositories.last_synced_at,
          syncError: row.repositories.sync_error
        }
      : null
  };
}

/** Starter files so an empty project is immediately workable. */
const STARTER_FILES = {
  'README.md': (name, description) =>
    `# ${name}\n\n${description || 'A project built with DiroxCode.'}\n\n## Getting started\n\nAsk DiroxCode what you want to build.\n`,
  '.gitignore': () => 'node_modules/\ndist/\nbuild/\n.env\n.env.local\n*.log\n.DS_Store\n'
};

export async function createEmptyWorkspace(projectId, { name, description }) {
  const dir = await ensureWorkspace(projectId);
  const { writeWorkspaceFile } = await import('../../exec/workspace.js');
  for (const [path, build] of Object.entries(STARTER_FILES)) {
    await writeWorkspaceFile(projectId, path, build(name, description));
  }
  return dir;
}

/**
 * Extract a GitHub tarball into the workspace.
 * `tar` is invoked directly with a fixed argument list — no shell, so no
 * archive name can be interpreted as a flag or a command.
 */
async function extractTarball(response, projectId) {
  const workspace = await ensureWorkspace(projectId);
  const staging = `${workspace}.incoming`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const archivePath = join(staging, 'source.tar.gz');
  let bytes = 0;

  await pipeline(
    (async function* () {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE_BYTES) throw payloadTooLarge('The repository archive exceeds the size limit for this plan');
        yield chunk;
      }
    })(),
    createWriteStream(archivePath)
  );

  await new Promise((done, fail) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', staging, '--strip-components=1'], { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', code => (code === 0 ? done() : fail(new AppError('The repository archive could not be extracted', { status: 502, code: 'extract_failed' }))));
  });

  await rm(archivePath, { force: true });
  await rm(workspace, { recursive: true, force: true });
  await rename(staging, workspace);

  const entries = await readdir(workspace).catch(() => []);
  if (!entries.length) throw upstreamFailed('The repository archive was empty');
  return { bytes };
}

// ─── queued jobs ────────────────────────────────────────────────────────────

registerHandler('project.import', async ({ projectId, repositoryId, ref, userId }) => {
  const client = serviceClient();
  const repository = await client.from('repositories').select('id,full_name,default_branch,project_id').eq('id', repositoryId).first();
  if (!repository) throw notFound('Repository record is missing');

  await client.from('projects').eq('id', projectId).update({ status: 'indexing', index_status: 'running' });

  try {
    const token = await repositoryToken(repositoryId);
    const response = await downloadTarball(token, repository.full_name, ref || repository.default_branch);
    const { bytes } = await extractTarball(response, projectId);

    await client.from('repositories').eq('id', repositoryId).update({
      last_synced_at: new Date().toISOString(), sync_error: null
    });

    const summary = await indexProject(projectId, { full: true });

    // A clone can be repeated from the remote, but only while the remote is
    // reachable and the token is valid. Snapshotting now means the project
    // survives both being false later.
    await snapshotWorkspace(projectId).catch(() => {});

    await notify({
      userId, kind: 'system', severity: 'success',
      title: 'Project ready',
      body: `${repository.full_name} was imported and indexed: ${summary.files} files, ${summary.symbols} symbols.`,
      link: `/app/projects/${projectId}`
    });

    return { bytes, ...summary, detected: undefined };
  } catch (error) {
    await client.from('repositories').eq('id', repositoryId).update({ sync_error: String(error?.message).slice(0, 300) }).catch(() => {});
    await client.from('projects').eq('id', projectId).update({
      status: 'error', index_status: 'failed', index_error: String(error?.message).slice(0, 500)
    }).catch(() => {});
    await notify({
      userId, kind: 'system', severity: 'critical',
      title: 'Project import failed',
      body: String(error?.message || error).slice(0, 300),
      link: `/app/projects/${projectId}`
    });
    throw error;
  }
});

registerHandler('project.index', async ({ projectId, full = false }) => {
  const summary = await indexProject(projectId, { full });
  const size = await workspaceSize(projectId).catch(() => 0);
  await serviceClient().from('projects').eq('id', projectId).update({ size_bytes: size });
  return { ...summary, detected: undefined };
});

registerHandler('project.delete', async ({ projectId }) => {
  await removeWorkspace(projectId);
  await forgetProject(projectId).catch(() => {});
  invalidate(projectId);
  return { removed: true };
});

// ─── entry points used by routes ────────────────────────────────────────────

export async function queueImport({ projectId, repositoryId, ref, orgId, userId }) {
  return enqueue({
    kind: 'project.import', queue: QUEUES.index, priority: 10,
    payload: { projectId, repositoryId, ref, userId }, orgId, projectId
  });
}

export async function queueIndex({ projectId, orgId, full = false }) {
  return enqueue({
    kind: 'project.index', queue: QUEUES.index, priority: 50,
    payload: { projectId, full }, orgId, projectId
  });
}

export async function queueWorkspaceCleanup({ projectId, orgId }) {
  return enqueue({ kind: 'project.delete', queue: QUEUES.maintenance, payload: { projectId }, orgId });
}

export { MAX_ARCHIVE_BYTES, extractTarball };
