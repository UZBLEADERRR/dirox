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
import { deliverableRoutes } from './modules/projects/deliverables.routes.js';
import { uploadRoutes } from './modules/uploads/routes.js';
import { supabaseRoutes } from './modules/projects/supabase.routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { taskRoutes } from './modules/agent/task.routes.js';
import { conversationRoutes } from './modules/agent/conversation.routes.js';
import { searchRoutes } from './modules/search/routes.js';

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
  api.use('/deliverables', deliverableRoutes());
  api.use('/uploads', uploadRoutes());
  api.use('/integrations/supabase', supabaseRoutes());
  api.use('/tasks', taskRoutes());
  api.use('/conversations', conversationRoutes());
  api.use('/search', searchRoutes());
  api.use('/notifications', notificationRoutes());
  api.use('/billing', billingRoutes());
  api.use('/admin', adminRoutes());

  router.use('/api', api);
  return router;
}
