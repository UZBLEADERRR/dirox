/**
 * GitHub OAuth and repository browsing.
 *
 * The token is exchanged server-side and stored encrypted. The browser is only
 * ever told whether an account is connected and which repositories it can see.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, forbidden, notConfigured, notFound } from '../../core/errors.js';
import { config, capabilities } from '../../config/env.js';
import { audit } from '../observability/audit.js';
import { verifyToken } from '../auth/service.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { loadProject } from './routes.js';
import {
  beginOAuth, consumeState, exchangeCode, getViewer, listRepositories, listBranches,
  saveIntegration, getIntegration, getIntegrationToken, revokeIntegration,
  createPullRequest, repositoryToken
} from './github.js';
import { queueImport } from './service.js';

export function githubRoutes() {
  const router = new Router();

  router.get('/status', async ctx => {
    if (!capabilities().github) {
      return sendJson(ctx.res, 200, { available: false, connected: false, reason: 'GitHub OAuth is not configured on this deployment' });
    }
    const integration = await getIntegration(ctx.auth.user.id, 'github');
    return sendJson(ctx.res, 200, {
      available: true,
      connected: Boolean(integration),
      account: integration ? { login: integration.account_login, name: integration.account_name, avatarUrl: integration.avatar_url } : null
    });
  }, { auth: true });

  /**
   * Start the OAuth dance.
   *
   * The bearer token cannot ride along on a browser redirect, so the caller
   * requests the authorize URL here and the browser follows it.
   */
  router.post('/connect', async ctx => {
    if (!capabilities().github) throw notConfigured('GitHub integration');
    if (!hasServiceRole()) throw notConfigured('Connected accounts (SUPABASE_SERVICE_ROLE_KEY)');
    const body = await ctx.json().catch(() => ({}));
    const { url } = beginOAuth(ctx.auth.user.id, String(body.returnTo || '/app/projects').slice(0, 200));
    return sendJson(ctx.res, 200, { url });
  }, { auth: true });

  /** GitHub redirects the browser here. No session header is available. */
  router.get('/callback', async ctx => {
    const code = String(ctx.query.code || '');
    const state = String(ctx.query.state || '');
    const redirect = target => {
      ctx.res.statusCode = 302;
      ctx.res.setHeader('Location', target);
      ctx.res.end();
    };

    if (!code || !state) return redirect('/app/projects?github=denied');

    try {
      const { userId, returnTo } = consumeState(state);
      const token = await exchangeCode(code);
      const viewer = await getViewer(token);
      await saveIntegration(userId, 'github', token, viewer, ['repo', 'read:user']);

      audit.record({ actorId: userId, action: 'github.connected', resource: 'integration', metadata: { login: viewer.login } });
      return redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}github=connected`);
    } catch (error) {
      ctx.log.warn('github callback failed', { reason: error?.message });
      return redirect('/app/projects?github=failed');
    }
  }, { auth: false, rateLimit: 'auth' });

  router.delete('/connect', async ctx => {
    await revokeIntegration(ctx.auth.user.id, 'github');
    audit.record({ actorId: ctx.auth.user.id, action: 'github.disconnected', severity: 'warning' });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: true });

  router.get('/repositories', async ctx => {
    const token = await getIntegrationToken(ctx.auth.user.id, 'github');
    if (!token) throw badRequest('Connect your GitHub account first');
    const repositories = await listRepositories(token, {
      page: Math.max(1, Number(ctx.query.page) || 1),
      perPage: Math.min(100, Number(ctx.query.perPage) || 50),
      query: String(ctx.query.q || '').slice(0, 80)
    });
    return sendJson(ctx.res, 200, { repositories });
  }, { auth: true, rateLimit: 'heavy' });

  router.get('/repositories/:owner/:name/branches', async ctx => {
    const token = await getIntegrationToken(ctx.auth.user.id, 'github');
    if (!token) throw badRequest('Connect your GitHub account first');
    const fullName = `${ctx.params.owner}/${ctx.params.name}`;
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw badRequest('Invalid repository name');
    const branches = await listBranches(token, fullName);
    return sendJson(ctx.res, 200, { branches });
  }, { auth: true });

  /** Pull the latest commit of the tracked branch and re-index. */
  router.post('/projects/:id/sync', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    if (!ctx.auth.canWrite) throw forbidden('Your role in this organization is read-only');
    if (!project.repositories?.id) throw badRequest('This project is not connected to a repository');
    if (!hasServiceRole()) throw notConfigured('Repository sync (SUPABASE_SERVICE_ROLE_KEY)');

    const body = await ctx.json().catch(() => ({}));
    const job = await queueImport({
      projectId: project.id,
      repositoryId: project.repositories.id,
      ref: String(body.branch || project.repositories.default_branch || 'main').slice(0, 100),
      orgId: ctx.auth.org.id,
      userId: ctx.auth.user.id
    });

    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'repository.sync', resourceId: project.id });
    return sendJson(ctx.res, 202, { jobId: job?.id, status: 'queued' });
  }, { auth: 'write', rateLimit: 'heavy' });

  /**
   * Open a pull request from the branch the agent worked on.
   * Explicitly gated: this writes to the user's GitHub account.
   */
  router.post('/projects/:id/pull-request', async ctx => {
    const project = await loadProject(ctx, ctx.params.id);
    if (!ctx.auth.canWrite) throw forbidden('Your role in this organization is read-only');
    if (!project.repositories?.full_name) throw badRequest('This project is not connected to a repository');

    const body = parse(t.object({
      title: t.string({ required: true, min: 3, max: 120 }),
      head: t.string({ required: true, max: 100 }),
      base: t.string({ max: 100 }),
      body: t.string({ max: 4000, truncate: true, default: '' })
    }), await ctx.json());

    const token = await repositoryToken(project.repositories.id);
    const pr = await createPullRequest(token, project.repositories.full_name, {
      title: body.title,
      head: body.head,
      base: body.base || project.repositories.default_branch || 'main',
      body: `${body.body}\n\n---\nOpened by DiroxCode.`
    });

    await serviceClient().insert('git_operations', {
      project_id: project.id, user_id: ctx.auth.user.id, operation: 'pull_request',
      branch: body.head, message: body.title, status: 'success',
      details: { number: pr.number, url: pr.html_url }
    }, { returning: false }).catch(() => {});

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'github.pull_request_created',
      resource: 'pull_request', resourceId: String(pr.number), severity: 'warning',
      metadata: { repository: project.repositories.full_name }
    });

    return sendJson(ctx.res, 201, { pullRequest: { number: pr.number, url: pr.html_url, state: pr.state } });
  }, { auth: 'write', rateLimit: 'heavy' });

  return router;
}
