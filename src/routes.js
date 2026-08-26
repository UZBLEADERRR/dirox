/**
 * The API surface, in one place.
 *
 * Modules export a Router; this file decides where each is mounted and what
 * authorization level applies. Keeping the map here makes the whole attack
 * surface reviewable at a glance.
 */

import { Router, sendJson } from './core/http.js';
import { capabilities } from './config/env.js';
import { runtimeStats } from './modules/observability/audit.js';
import { authRoutes } from './modules/auth/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { orgRoutes } from './modules/orgs/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { billingRoutes } from './modules/billing/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { githubRoutes } from './modules/projects/github.routes.js';

export function registerRoutes(router) {
  const api = new Router();

  api.get('/health', async ctx => {
    sendJson(ctx.res, 200, {
      ok: true,
      service: 'diroxcode',
      version: '2.0.0',
      capabilities: capabilities(),
      runtime: runtimeStats.snapshot()
    });
  }, { auth: false, rateLimit: false });

  api.use('/auth', authRoutes());
  api.use('/me', userRoutes());
  api.use('/organizations', orgRoutes());
  api.use('/projects', projectRoutes());
  api.use('/github', githubRoutes());
  api.use('/notifications', notificationRoutes());
  api.use('/billing', billingRoutes());

  router.use('/api', api);
  return router;
}
