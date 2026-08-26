/**
 * Git tools.
 *
 * Read operations are free. Commits are a write. Anything that reaches the
 * remote — push, pull request — is `outward` and always requires approval,
 * whatever the trust level.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { runCommand } from '../../exec/sandbox.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';

async function git(ctx, args, options = {}) {
  return runCommand(ctx.projectId, `git ${args}`, {
    timeoutMs: options.timeoutMs || 60_000,
    maxOutput: options.maxOutput || 30_000,
    signal: ctx.signal
  });
}

async function recordOperation(ctx, operation, details) {
  if (!hasServiceRole()) return;
  await serviceClient().insert('git_operations', {
    project_id: ctx.projectId,
    task_id: ctx.taskId ?? null,
    user_id: ctx.userId ?? null,
    operation,
    branch: details.branch ?? null,
    sha: details.sha ?? null,
    message: details.message ?? null,
    status: details.ok === false ? 'failed' : 'success',
    error: details.error ?? null,
    details: details.extra ?? {}
  }, { returning: false }).catch(() => {});
}

export const gitTools = [
  {
    name: 'git_status',
    risk: RISK.SAFE,
    description: 'Show which files have been added, modified or deleted in the working tree.',
    schema: t.object({}),
    async run(_args, ctx) {
      const result = await git(ctx, 'status --porcelain=v1 --branch');
      if (!result.ok) return { ok: false, output: 'This project is not a git repository.', metadata: { isRepo: false } };

      const lines = result.stdout.split('\n').filter(Boolean);
      const branch = lines.find(line => line.startsWith('##'))?.slice(3) ?? '';
      const changes = lines.filter(line => !line.startsWith('##'));

      return {
        output: changes.length
          ? `Branch: ${branch}\n${changes.length} changed file(s):\n${changes.join('\n')}`
          : `Branch: ${branch}\nWorking tree is clean.`,
        metadata: { branch, changed: changes.length, clean: changes.length === 0 }
      };
    }
  },

  {
    name: 'git_diff',
    risk: RISK.SAFE,
    description: 'Show the diff of uncommitted changes. Use this to review your own work before committing.',
    schema: t.object({
      path: t.string({ max: 300, description: 'Optional single file to diff' }),
      staged: t.boolean({ default: false })
    }),
    async run({ path, staged }, ctx) {
      const args = ['diff', staged ? '--cached' : null, '--unified=3', path ? `-- ${path}` : null]
        .filter(Boolean).join(' ');
      const result = await git(ctx, args, { maxOutput: 60_000 });

      if (!result.stdout.trim()) return { output: 'No uncommitted changes.', metadata: { empty: true } };
      return { output: result.output, metadata: { truncated: result.truncated } };
    }
  },

  {
    name: 'git_log',
    risk: RISK.SAFE,
    description: 'Show recent commits, to understand how the code got to its current state.',
    schema: t.object({
      limit: t.integer({ min: 1, max: 50, default: 10 }),
      path: t.string({ max: 300, description: 'Optional file to show history for' })
    }),
    async run({ limit, path }, ctx) {
      const args = `log --oneline --no-decorate -n ${limit}${path ? ` -- ${path}` : ''}`;
      const result = await git(ctx, args);
      return {
        output: result.stdout.trim() || 'No commits yet.',
        metadata: { commits: result.stdout.split('\n').filter(Boolean).length }
      };
    }
  },

  {
    name: 'git_branch',
    risk: RISK.WRITE,
    description: 'List branches, or create and switch to a new one.',
    schema: t.object({
      create: t.string({ max: 100, description: 'Name of a new branch to create and switch to' })
    }),
    async run({ create }, ctx) {
      if (!create) {
        const result = await git(ctx, 'branch --list');
        return { output: result.stdout.trim() || 'No branches.', metadata: {} };
      }

      if (!/^[\w./-]{1,100}$/.test(create)) throw badRequest('Branch names may contain letters, numbers, dot, slash, dash and underscore');
      const result = await git(ctx, `checkout -b ${create}`);
      await recordOperation(ctx, 'branch', { branch: create, ok: result.ok, error: result.ok ? null : result.output });

      if (!result.ok) return { ok: false, output: result.output, metadata: { branch: create } };
      return { output: `Created and switched to ${create}`, metadata: { branch: create } };
    }
  },

  {
    name: 'git_commit',
    risk: RISK.WRITE,
    description: 'Stage the changed files and commit them. Write a message that explains why, not what.',
    schema: t.object({
      message: t.string({ required: true, min: 5, max: 500 }),
      paths: t.array(t.string({ max: 300 }), { max: 50, description: 'Files to stage; all changes if omitted' })
    }),
    async run({ message, paths }, ctx) {
      const stage = paths?.length ? `add ${paths.join(' ')}` : 'add -A';
      const staged = await git(ctx, stage);
      if (!staged.ok) return { ok: false, output: `Could not stage changes:\n${staged.output}`, metadata: {} };

      // The message goes through -m as a single argv entry, so it cannot break
      // out into another command.
      const result = await git(ctx, `commit -m ${JSON.stringify(message)}`);
      if (!result.ok) {
        const nothing = /nothing to commit/i.test(result.output);
        await recordOperation(ctx, 'commit', { message, ok: false, error: result.output });
        return { ok: false, output: nothing ? 'There is nothing to commit.' : result.output, metadata: { nothingToCommit: nothing } };
      }

      const sha = (await git(ctx, 'rev-parse --short HEAD')).stdout.trim();
      await recordOperation(ctx, 'commit', { message, sha, ok: true });
      return { output: `Committed ${sha}: ${message}`, metadata: { sha, message } };
    }
  },

  {
    name: 'git_revert',
    risk: RISK.DESTRUCTIVE,
    description: 'Discard uncommitted changes to a file, restoring it to the last commit. Requires approval.',
    schema: t.object({ path: t.string({ required: true, max: 300 }) }),
    async run({ path }, ctx) {
      const result = await git(ctx, `checkout -- ${path}`);
      await recordOperation(ctx, 'revert', { message: path, ok: result.ok });
      if (!result.ok) return { ok: false, output: result.output, metadata: {} };
      ctx.recordFileChange(path, 'reverted');
      return { output: `Restored ${path} to its last committed state`, metadata: { path } };
    }
  },

  {
    name: 'git_push',
    risk: RISK.OUTWARD,
    description: 'Push commits to the remote repository. Always requires approval.',
    schema: t.object({
      branch: t.string({ max: 100 }),
      setUpstream: t.boolean({ default: true })
    }),
    async run({ branch, setUpstream }, ctx) {
      const target = branch || (await git(ctx, 'rev-parse --abbrev-ref HEAD')).stdout.trim();
      if (!/^[\w./-]{1,100}$/.test(target)) throw badRequest('Invalid branch name');

      const result = await git(ctx, `push ${setUpstream ? '-u ' : ''}origin ${target}`, { timeoutMs: 120_000 });
      await recordOperation(ctx, 'push', { branch: target, ok: result.ok, error: result.ok ? null : result.output });

      if (!result.ok) return { ok: false, output: `Push failed:\n${result.output}`, metadata: { branch: target } };
      return { output: `Pushed to origin/${target}`, metadata: { branch: target } };
    }
  }
];

export { recordOperation };
