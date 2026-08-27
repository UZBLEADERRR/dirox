/**
 * Project API.
 *
 * Reads go through the caller's RLS-scoped client, so a project belonging to
 * another organization simply does not exist as far as these queries are
 * concerned. Writes additionally check the plan's limits.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, conflict, notFound, notConfigured } from '../../core/errors.js';
import { audit } from '../observability/audit.js';
import { assertWithinPlan, invalidatePlanUsage } from '../billing/usage.js';
import { capabilities } from '../../config/env.js';
import { hasServiceRole, serviceClient } from '../../db/supabase.js';
import {
  shapeProject, uniqueSlug, createEmptyWorkspace,
  queueImport, queueIndex, queueWorkspaceCleanup
} from './service.js';
import { REPOSITORY_COLUMNS, storeRepositoryToken } from './github.js';
import {
  listWorkspace, readWorkspaceFile, writeWorkspaceFile,
  workspaceExists, isSecretPath
} from '../../exec/workspace.js';
import { materialiseWorkspace } from '../../exec/persistence.js';

const PROJECT_COLUMNS = '*,repositories(id,provider,full_name,owner,name,html_url,default_branch,visibility,last_synced_at,sync_error)';

/** Load a project the caller may read, or 404. */
async function loadProject(ctx, projectId) {
  const id = parse(uuid({ required: true }), projectId);
  const row = await ctx.auth.db.from('projects').select(PROJECT_COLUMNS).eq('id', id).first();
  if (!row) throw notFound('Project not found');
  return row;
}

function requireWritable(ctx) {
  if (!ctx.auth.canWrite) throw badRequest('Your role in this organization is read-only');
}

export function projectRoutes() {
  const router = new Router();

  router.get('/', async ctx => {
    const includeArchived = ctx.query.archived === 'true';
    let query = ctx.auth.db.from('projects').select(PROJECT_COLUMNS).eq('org_id', ctx.auth.org.id);
    if (!includeArchived) query = query.is('archived_at', 'null');
    if (ctx.query.q) query = query.like('name', String(ctx.query.q).slice(0, 60));

    const rows = await query.order('updated_at').limit(Number(ctx.query.limit) || 50).all();
    return sendJson(ctx.res, 200, { projects: rows.map(shapeProject) });
  }, { auth: true });

  /**
   * Create a project. `source` decides what happens next:
   *   empty  — a starter workspace is written immediately
   *   github — a clone + index job is queued
   */
  router.post('/', async ctx => {
    requireWritable(ctx);
    await assertWithinPlan(ctx.auth, 'project');

    const body = parse(t.object({
      name: t.string({ required: true, min: 1, max: 80 }),
      description: t.string({ max: 500, truncate: true, default: '' }),
      source: t.enum(['empty', 'github'], { default: 'empty' }),
      repository: t.object({
        externalId: t.string({ max: 40 }),
        fullName: t.string({ max: 140 }),
        owner: t.string({ max: 60 }),
        name: t.string({ max: 100 }),
        htmlUrl: t.string({ max: 300 }),
        cloneUrl: t.string({ max: 300 }),
        defaultBranch: t.string({ max: 100, default: 'main' }),
        private: t.boolean({ default: true })
      }),
      branch: t.string({ max: 100 })
    }), await ctx.json());

    const slug = await uniqueSlug(ctx.auth.db, ctx.auth.org.id, body.name);

    const project = await ctx.auth.db.insert('projects', {
      org_id: ctx.auth.org.id,
      created_by: ctx.auth.user.id,
      name: body.name,
      slug,
      description: body.description,
      status: body.source === 'github' ? 'indexing' : 'created',
      index_status: 'pending'
    });

    await ctx.auth.db.insert('project_members', {
      project_id: project.id, user_id: ctx.auth.user.id, role: 'owner'
    }, { returning: false }).catch(() => {});

    if (body.source === 'github') {
      if (!capabilities().github) throw notConfigured('GitHub integration');
      if (!body.repository?.fullName) throw badRequest('A repository must be selected');
      if (!hasServiceRole()) throw notConfigured('Repository import (SUPABASE_SERVICE_ROLE_KEY)');

      const token = ctx.state.githubToken || await githubTokenFor(ctx);
      if (!token) throw badRequest('Connect your GitHub account before importing a repository');

      const repository = await ctx.auth.db.insert('repositories', {
        project_id: project.id,
        provider: 'github',
        external_id: body.repository.externalId ?? null,
        owner: body.repository.owner,
        name: body.repository.name,
        full_name: body.repository.fullName,
        clone_url: body.repository.cloneUrl ?? null,
        html_url: body.repository.htmlUrl ?? null,
        default_branch: body.branch || body.repository.defaultBranch || 'main',
        visibility: body.repository.private ? 'private' : 'public',
        installed_by: ctx.auth.user.id
      });

      await storeRepositoryToken(repository.id, token);
      await queueImport({
        projectId: project.id, repositoryId: repository.id,
        ref: body.branch || body.repository.defaultBranch,
        orgId: ctx.auth.org.id, userId: ctx.auth.user.id
      });
    } else {
      await createEmptyWorkspace(project.id, { name: body.name, description: body.description });
      if (hasServiceRole()) await queueIndex({ projectId: project.id, orgId: ctx.auth.org.id, full: true });
    }

    invalidatePlanUsage(ctx.auth.org.id);
    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'project.created',
      resource: 'project', resourceId: project.id, metadata: { source: body.source }
    });

    return sendJson(ctx.res, 201, { project: shapeProject(project) });
  }, { auth: 'write', rateLimit: 'heavy' });

  router.get('/:id', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    const [tasks, checkpoints, workspaceReady] = await Promise.all([
      ctx.auth.db.from('tasks').select('id,title,status,mode,created_at,finished_at,spent_micros')
        .eq('project_id', project.id).order('created_at').limit(8).all(),
      ctx.auth.db.from('checkpoints').select('id,label,kind,created_at,files')
        .eq('project_id', project.id).order('created_at').limit(5).all(),
      // A container newer than the project has an empty workspace; rebuild it
      // before reporting whether the project has any files.
      materialiseWorkspace(project.id).then(() => workspaceExists(project.id)).catch(() => false)
    ]);

    return sendJson(ctx.res, 200, {
      project: shapeProject(project),
      workspaceReady,
      recentTasks: tasks.map(task => ({
        id: task.id, title: task.title, status: task.status, mode: task.mode,
        createdAt: task.created_at, finishedAt: task.finished_at, costMicros: Number(task.spent_micros || 0)
      })),
      checkpoints: checkpoints.map(cp => ({
        id: cp.id, label: cp.label, kind: cp.kind, createdAt: cp.created_at,
        fileCount: Array.isArray(cp.files) ? cp.files.length : 0
      }))
    });
  }, { auth: true });

  router.patch('/:id', async ctx => {
    requireWritable(ctx);
    const project = await loadProject(ctx, ctx.params.id);
    const body = parse(t.object({
      name: t.string({ min: 1, max: 80 }),
      description: t.string({ max: 500, truncate: true }),
      testCommand: t.string({ max: 200 }),
      buildCommand: t.string({ max: 200 }),
      devCommand: t.string({ max: 200 }),
      deployCommand: t.string({ max: 300 }),
      settings: t.object({}, { passthrough: true })
    }), await ctx.json());

    const patch = {};
    if (body.name) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.testCommand !== undefined) patch.test_command = body.testCommand || null;
    if (body.buildCommand !== undefined) patch.build_command = body.buildCommand || null;
    if (body.devCommand !== undefined) patch.dev_command = body.devCommand || null;
    if (body.deployCommand !== undefined) patch.deploy_command = body.deployCommand || null;
    if (body.settings) patch.settings = body.settings;
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const [row] = await ctx.auth.db.from('projects').eq('id', project.id).update(patch);
    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'project.updated', resource: 'project', resourceId: project.id });
    return sendJson(ctx.res, 200, { project: shapeProject({ ...row, repositories: project.repositories }) });
  }, { auth: 'write' });

  router.post('/:id/archive', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    const archived = !project.archived_at;
    const [row] = await ctx.auth.db.from('projects').eq('id', project.id).update({
      archived_at: archived ? new Date().toISOString() : null,
      status: archived ? 'archived' : 'ready'
    });
    invalidatePlanUsage(ctx.auth.org.id);
    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: archived ? 'project.archived' : 'project.restored', resourceId: project.id });
    return sendJson(ctx.res, 200, { project: shapeProject(row) });
  }, { auth: 'write' });

  router.delete('/:id', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    await ctx.auth.db.from('projects').eq('id', project.id).remove();
    if (hasServiceRole()) await queueWorkspaceCleanup({ projectId: project.id, orgId: ctx.auth.org.id }).catch(() => {});
    invalidatePlanUsage(ctx.auth.org.id);
    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'project.deleted',
      resource: 'project', resourceId: project.id, severity: 'warning', metadata: { name: project.name }
    });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'orgAdmin', rateLimit: 'heavy' });

  /** Re-index. Incremental by default; `full=true` rebuilds from scratch. */
  router.post('/:id/index', async ctx => {
    requireWritable(ctx);
    const project = await loadProject(ctx, ctx.params.id);
    if (!hasServiceRole()) throw notConfigured('Background indexing (SUPABASE_SERVICE_ROLE_KEY)');
    if (project.index_status === 'running') throw conflict('This project is already being indexed');

    const body = await ctx.json().catch(() => ({}));
    await ctx.auth.db.from('projects').eq('id', project.id).update({ index_status: 'running', index_error: null });
    const job = await queueIndex({ projectId: project.id, orgId: ctx.auth.org.id, full: body.full === true });
    return sendJson(ctx.res, 202, { jobId: job?.id, status: 'queued' });
  }, { auth: 'write', rateLimit: 'heavy' });

  // ─── file access ──────────────────────────────────────────────────────────

  /** The indexed file list, or a path search. Never the file contents. */
  router.get('/:id/files', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    const limit = Math.min(500, Number(ctx.query.limit) || 200);

    let query = ctx.auth.db.from('files')
      .select('id,path,directory,extension,language,size_bytes,line_count,importance,is_generated')
      .eq('project_id', project.id);
    if (ctx.query.q) query = query.like('path', String(ctx.query.q).slice(0, 80));
    if (ctx.query.directory) query = query.eq('directory', String(ctx.query.directory).slice(0, 200));

    const rows = await query.order('importance').limit(limit).all();

    // Fall back to the live workspace when the index has not run yet.
    if (!rows.length && project.index_status !== 'ready') {
      const { entries } = await listWorkspace(project.id, { maxEntries: limit }).catch(() => ({ entries: [] }));
      return sendJson(ctx.res, 200, {
        files: entries.map(entry => ({ path: entry.path, sizeBytes: entry.size, indexed: false })),
        indexed: false
      });
    }

    return sendJson(ctx.res, 200, {
      files: rows.map(row => ({
        id: row.id, path: row.path, directory: row.directory, extension: row.extension,
        language: row.language, sizeBytes: row.size_bytes, lineCount: row.line_count,
        importance: row.importance, isGenerated: row.is_generated
      })),
      indexed: true
    });
  }, { auth: true });

  router.get('/:id/file', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    const path = String(ctx.query.path || '');
    if (!path) throw badRequest('A file path is required');
    if (isSecretPath(path)) throw badRequest('This file may contain credentials and cannot be opened here');

    // The workspace may belong to an older container than this request does.
    await materialiseWorkspace(project.id).catch(() => {});

    const file = await readWorkspaceFile(project.id, path);
    return sendJson(ctx.res, 200, { file });
  }, { auth: true });

  router.put('/:id/file', async ctx => {
    requireWritable(ctx);
    const project = await loadProject(ctx, ctx.params.id);
    const body = parse(t.object({
      path: t.string({ required: true, max: 400 }),
      content: t.string({ required: true, max: 2_000_000, trim: false })
    }), await ctx.json());

    const result = await writeWorkspaceFile(project.id, body.path, body.content);
    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'file.edited', resource: 'file', resourceId: body.path, metadata: { projectId: project.id } });
    if (hasServiceRole()) await queueIndex({ projectId: project.id, orgId: ctx.auth.org.id }).catch(() => {});
    return sendJson(ctx.res, 200, { file: result });
  }, { auth: 'write' });

  /** Symbols for one file, or a project-wide symbol lookup by name. */
  router.get('/:id/symbols', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    let query = ctx.auth.db.from('code_symbols')
      .select('id,name,kind,signature,start_line,end_line,is_exported,files(path)')
      .eq('project_id', project.id);
    if (ctx.query.name) query = query.like('name', String(ctx.query.name).slice(0, 80));
    if (ctx.query.fileId) query = query.eq('file_id', parse(uuid({ required: true }), ctx.query.fileId));

    const rows = await query.limit(Math.min(300, Number(ctx.query.limit) || 100)).all();
    return sendJson(ctx.res, 200, {
      symbols: rows.map(row => ({
        id: row.id, name: row.name, kind: row.kind, signature: row.signature,
        startLine: row.start_line, endLine: row.end_line, isExported: row.is_exported,
        path: row.files?.path
      }))
    });
  }, { auth: true });

  /** Project memory: what the agent has learned and remembers. */
  router.get('/:id/memory', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    const rows = await ctx.auth.db.from('project_memory')
      .select('id,kind,key,content,importance,source,hit_count,created_at')
      .eq('project_id', project.id).eq('scope', 'project')
      .order('importance').limit(100).all();
    return sendJson(ctx.res, 200, { memory: rows });
  }, { auth: true });

  router.post('/:id/memory', async ctx => {
    requireWritable(ctx);
    const project = await loadProject(ctx, ctx.params.id);
    const body = parse(t.object({
      kind: t.enum(['architecture', 'convention', 'rule', 'dependency', 'bug', 'deployment', 'preference', 'solution', 'note'], { default: 'note' }),
      key: t.string({ max: 80 }),
      content: t.string({ required: true, max: 2000 }),
      importance: t.number({ min: 0, max: 1, default: 0.6 })
    }), await ctx.json());

    if (/(?:api[_-]?key|secret|password|token)\s*[:=]/i.test(body.content)) {
      throw badRequest('Project memory must not contain credentials. Store secrets in your deployment environment instead.');
    }

    const row = await ctx.auth.db.insert('project_memory', {
      project_id: project.id, scope: 'project', kind: body.kind, key: body.key || null,
      content: body.content, importance: body.importance, source: 'user',
      tokens: Math.ceil(body.content.length / 4)
    }, { upsert: Boolean(body.key), onConflict: body.key ? 'project_id,kind,key' : undefined });

    return sendJson(ctx.res, 201, { memory: row });
  }, { auth: 'write' });

  router.delete('/:id/memory/:memoryId', async ctx => {
    requireWritable(ctx);
    const project = await loadProject(ctx, ctx.params.id);
    const memoryId = parse(uuid({ required: true }), ctx.params.memoryId);
    await ctx.auth.db.from('project_memory').eq('id', memoryId).eq('project_id', project.id).remove();
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'write' });

  return router;
}

/** The caller's stored GitHub token, if they have connected an account. */
async function githubTokenFor(ctx) {
  const { getIntegrationToken } = await import('./github.js');
  return getIntegrationToken(ctx.auth.user.id, 'github');
}

export { loadProject, PROJECT_COLUMNS, githubTokenFor };
