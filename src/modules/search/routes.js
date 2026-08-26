/**
 * Global search.
 *
 * Searches projects, files, symbols, tasks and conversations in one round trip,
 * scoped to the caller's organization by RLS. Queries run in parallel and each
 * is bounded, so a broad search stays fast.
 */

import { Router, sendJson } from '../../core/http.js';
import { badRequest } from '../../core/errors.js';

const MIN_QUERY = 2;

export function searchRoutes() {
  const router = new Router();

  router.get('/', async ctx => {
    const query = String(ctx.query.q || '').trim().slice(0, 100);
    if (query.length < MIN_QUERY) throw badRequest(`Search needs at least ${MIN_QUERY} characters`);

    const db = ctx.auth.db;
    const limit = Math.min(10, Number(ctx.query.limit) || 6);
    const projectId = ctx.query.projectId || null;

    const [projects, files, symbols, tasks, conversations] = await Promise.all([
      db.from('projects').select('id,name,slug,description,language,framework')
        .eq('org_id', ctx.auth.org.id).is('archived_at', 'null')
        .like('name', query).limit(limit).all().catch(() => []),

      (projectId
        ? db.from('files').select('id,path,language,project_id').eq('project_id', projectId)
        : db.from('files').select('id,path,language,project_id'))
        .like('path', query).order('importance').limit(limit * 2).all().catch(() => []),

      (projectId
        ? db.from('code_symbols').select('name,kind,start_line,project_id,files(path)').eq('project_id', projectId)
        : db.from('code_symbols').select('name,kind,start_line,project_id,files(path)'))
        .like('name', query).limit(limit * 2).all().catch(() => []),

      db.from('tasks').select('id,title,status,mode,project_id,created_at')
        .eq('org_id', ctx.auth.org.id).like('title', query)
        .order('created_at').limit(limit).all().catch(() => []),

      db.from('conversations').select('id,title,project_id,updated_at')
        .eq('user_id', ctx.auth.user.id).like('title', query)
        .order('updated_at').limit(limit).all().catch(() => [])
    ]);

    // Exact and prefix matches rank above substring matches.
    const rank = (text) => {
      const value = String(text || '').toLowerCase();
      const needle = query.toLowerCase();
      if (value === needle) return 3;
      if (value.startsWith(needle)) return 2;
      return 1;
    };

    return sendJson(ctx.res, 200, {
      query,
      results: {
        projects: projects.map(project => ({
          type: 'project', id: project.id, title: project.name,
          subtitle: [project.framework, project.language].filter(Boolean).join(' · ') || project.description,
          href: `/app/projects/${project.id}`, rank: rank(project.name)
        })),
        files: files.map(file => ({
          type: 'file', id: file.id, title: file.path,
          subtitle: file.language || '', projectId: file.project_id,
          href: `/app/projects/${file.project_id}?file=${encodeURIComponent(file.path)}`,
          rank: rank(file.path.split('/').pop())
        })).sort((a, b) => b.rank - a.rank).slice(0, limit),
        symbols: symbols.map(symbol => ({
          type: 'symbol', title: symbol.name,
          subtitle: `${symbol.kind} in ${symbol.files?.path || 'unknown'}`,
          projectId: symbol.project_id,
          href: symbol.files?.path
            ? `/app/projects/${symbol.project_id}?file=${encodeURIComponent(symbol.files.path)}&line=${symbol.start_line}`
            : null,
          rank: rank(symbol.name)
        })).sort((a, b) => b.rank - a.rank).slice(0, limit),
        tasks: tasks.map(task => ({
          type: 'task', id: task.id, title: task.title,
          subtitle: `${task.mode} · ${task.status}`,
          href: `/app/tasks/${task.id}`, rank: rank(task.title)
        })),
        conversations: conversations.map(conversation => ({
          type: 'conversation', id: conversation.id, title: conversation.title,
          subtitle: 'conversation',
          href: conversation.project_id
            ? `/app/projects/${conversation.project_id}/chat/${conversation.id}`
            : null,
          rank: rank(conversation.title)
        }))
      }
    });
  }, { auth: true });

  /** Content search inside one project, backed by the workspace not the index. */
  router.get('/code', async ctx => {
    const query = String(ctx.query.q || '').trim().slice(0, 200);
    const projectId = String(ctx.query.projectId || '');
    if (query.length < MIN_QUERY) throw badRequest(`Search needs at least ${MIN_QUERY} characters`);
    if (!projectId) throw badRequest('A projectId is required for code search');

    // Confirm the caller may read this project before touching the filesystem.
    const project = await ctx.auth.db.from('projects').select('id').eq('id', projectId).first();
    if (!project) throw badRequest('Project not found');

    const { listWorkspace, readWorkspaceFile, isTextFile, isSecretPath } = await import('../../exec/workspace.js');
    const { entries } = await listWorkspace(projectId, { maxEntries: 2000 });

    const matches = [];
    let filesSearched = 0;

    for (const entry of entries) {
      if (matches.length >= 60) break;
      if (!isTextFile(entry.path) || isSecretPath(entry.path) || entry.size > 400_000) continue;

      const file = await readWorkspaceFile(projectId, entry.path).catch(() => null);
      if (!file) continue;
      filesSearched += 1;

      const lines = file.content.split('\n');
      for (let index = 0; index < lines.length && matches.length < 60; index += 1) {
        if (!lines[index].toLowerCase().includes(query.toLowerCase())) continue;
        matches.push({
          path: entry.path,
          line: index + 1,
          text: lines[index].trim().slice(0, 200)
        });
      }
    }

    return sendJson(ctx.res, 200, { query, matches, filesSearched });
  }, { auth: true, rateLimit: 'heavy' });

  return router;
}
