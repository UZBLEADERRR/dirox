/**
 * Checkpoints.
 *
 * Before the agent makes its first change in a task, a checkpoint is created so
 * a bad result is always one click from undone. When the workspace is a git
 * repository the checkpoint is a commit reference plus a patch; otherwise the
 * contents of the files about to change are stored directly.
 *
 * Restoring is deliberately conservative: it writes back exactly what was
 * captured and reports what it could not restore, rather than guessing.
 */

import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { runCommand } from '../exec/sandbox.js';
import { readWorkspaceFile, writeWorkspaceFile, deleteWorkspacePath } from '../exec/workspace.js';
import { notFound, badRequest } from '../core/errors.js';
import { logger } from '../core/logger.js';

const MAX_INLINE_PATCH = 400_000;
const MAX_CAPTURED_FILES = 60;

async function isGitRepository(projectId) {
  const result = await runCommand(projectId, 'git rev-parse --is-inside-work-tree', { timeoutMs: 10_000 }).catch(() => null);
  return Boolean(result?.ok && result.stdout.trim() === 'true');
}

/**
 * @param {{projectId:string, taskId?:string, label?:string, kind?:string,
 *          userId?:string, paths?:string[], stepIndex?:number}} options
 */
export async function createCheckpoint({ projectId, taskId = null, label = '', kind = 'auto', userId = null, paths = [], stepIndex = null }) {
  if (!hasServiceRole()) return null;

  const files = [];
  let gitSha = null;
  let patch = null;

  if (await isGitRepository(projectId)) {
    const head = await runCommand(projectId, 'rev-parse HEAD'.replace(/^/, 'git '), { timeoutMs: 10_000 }).catch(() => null);
    gitSha = head?.ok ? head.stdout.trim() : null;

    // The diff against HEAD is the complete uncommitted state; replaying it in
    // reverse restores the working tree exactly.
    const diff = await runCommand(projectId, 'git diff HEAD', { timeoutMs: 30_000, maxOutput: MAX_INLINE_PATCH }).catch(() => null);
    if (diff?.stdout && !diff.truncated) patch = diff.stdout;

    const status = await runCommand(projectId, 'git status --porcelain=v1', { timeoutMs: 15_000 }).catch(() => null);
    for (const line of (status?.stdout || '').split('\n').filter(Boolean).slice(0, MAX_CAPTURED_FILES)) {
      files.push({ path: line.slice(3).trim(), state: line.slice(0, 2).trim() });
    }
  }

  // Without git — or when the diff was too large — capture the files that are
  // about to change, so a restore is still possible.
  if (!patch && paths.length) {
    for (const path of paths.slice(0, MAX_CAPTURED_FILES)) {
      const file = await readWorkspaceFile(projectId, path).catch(() => null);
      files.push(file
        ? { path, content: file.content, hash: file.hash, existed: true }
        : { path, existed: false });
    }
  }

  const sizeBytes = files.reduce((sum, file) => sum + (file.content?.length || 0), 0) + (patch?.length || 0);

  const row = await serviceClient().insert('checkpoints', {
    project_id: projectId,
    task_id: taskId,
    step_index: stepIndex,
    label: String(label).slice(0, 200),
    kind,
    git_sha: gitSha,
    patch: patch && patch.length <= MAX_INLINE_PATCH ? patch : null,
    files,
    size_bytes: sizeBytes,
    created_by: userId
  });

  logger.debug('checkpoint created', { projectId, taskId, kind, files: files.length, hasPatch: Boolean(patch) });
  return row;
}

/**
 * Restore a checkpoint.
 * @returns {Promise<{restored:string[], failed:Array<{path:string,reason:string}>, method:string}>}
 */
export async function restoreCheckpoint(checkpointId, { projectId }) {
  if (!hasServiceRole()) throw badRequest('Checkpoints are unavailable on this deployment');

  const client = serviceClient();
  const checkpoint = await client.from('checkpoints').select('*').eq('id', checkpointId).eq('project_id', projectId).first();
  if (!checkpoint) throw notFound('Checkpoint not found');

  const restored = [];
  const failed = [];

  // Preferred path: reverse-apply the captured diff.
  if (checkpoint.patch && await isGitRepository(projectId)) {
    const patchPath = `.diroxcode-restore-${Date.now()}.patch`;
    await writeWorkspaceFile(projectId, patchPath, checkpoint.patch);

    const result = await runCommand(projectId, `git apply --reverse --whitespace=nowarn ${patchPath}`, { timeoutMs: 60_000 });
    await deleteWorkspacePath(projectId, patchPath).catch(() => {});

    if (result.ok) {
      await client.from('checkpoints').eq('id', checkpointId).update({ restored_at: new Date().toISOString() });
      const paths = (checkpoint.files || []).map(file => file.path);
      return { restored: paths, failed: [], method: 'patch' };
    }
    // The tree moved on since the checkpoint; fall through to file restore.
    logger.warn('patch restore failed, falling back to captured files', { checkpointId, reason: result.output.slice(0, 200) });
  }

  // Fallback: write back exactly what was captured.
  for (const file of checkpoint.files || []) {
    if (file.content === undefined) {
      failed.push({ path: file.path, reason: 'Contents were not captured for this file' });
      continue;
    }
    try {
      if (file.existed === false) await deleteWorkspacePath(projectId, file.path).catch(() => {});
      else await writeWorkspaceFile(projectId, file.path, file.content);
      restored.push(file.path);
    } catch (error) {
      failed.push({ path: file.path, reason: error.message });
    }
  }

  if (!restored.length && !failed.length) {
    throw badRequest('This checkpoint captured no restorable content');
  }

  await client.from('checkpoints').eq('id', checkpointId).update({ restored_at: new Date().toISOString() });
  return { restored, failed, method: 'files' };
}

/** What changed since a checkpoint, without restoring it. */
export async function compareCheckpoint(checkpointId, { projectId }) {
  if (!hasServiceRole()) throw badRequest('Checkpoints are unavailable on this deployment');

  const checkpoint = await serviceClient().from('checkpoints')
    .select('id,label,created_at,files,git_sha').eq('id', checkpointId).eq('project_id', projectId).first();
  if (!checkpoint) throw notFound('Checkpoint not found');

  const changes = [];
  for (const file of checkpoint.files || []) {
    if (file.content === undefined) continue;
    const current = await readWorkspaceFile(projectId, file.path).catch(() => null);
    if (!current) { changes.push({ path: file.path, state: 'deleted since checkpoint' }); continue; }
    if (current.hash !== file.hash) changes.push({ path: file.path, state: 'modified since checkpoint' });
  }

  return { checkpoint: { id: checkpoint.id, label: checkpoint.label, createdAt: checkpoint.created_at }, changes };
}

export { isGitRepository, MAX_CAPTURED_FILES };
