/**
 * In-app notifications. Delivery respects the per-user preference map, so a
 * user who turned a category off never receives it.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, uuid } from '../../core/validate.js';
import { hasServiceRole, serviceClient } from '../../db/supabase.js';
import { logger } from '../../core/logger.js';

const KIND_TO_PREFERENCE = {
  task_completed: 'task_completed',
  task_failed: 'task_failed',
  approval_required: 'approval_required',
  security: 'security',
  billing: 'billing'
};

/**
 * Create a notification for a user, honouring their preferences.
 * Safe to call from anywhere: never throws into the caller's flow.
 */
export async function notify({ userId, orgId = null, kind, title, body = '', link = null, severity = 'info' }) {
  if (!userId || !kind || !title) return null;
  if (!hasServiceRole()) return null;
  try {
    const client = serviceClient();
    const preferenceKey = KIND_TO_PREFERENCE[kind];
    if (preferenceKey) {
      const profile = await client.from('profiles').select('notification_preferences').eq('id', userId).first();
      if (profile?.notification_preferences?.[preferenceKey] === false) return null;
    }
    return await client.insert('notifications', {
      user_id: userId, org_id: orgId, kind, title: String(title).slice(0, 160),
      body: String(body).slice(0, 1000), link, severity
    });
  } catch (error) {
    logger.warn('notification not delivered', { kind, reason: error?.message });
    return null;
  }
}

export function notificationRoutes() {
  const router = new Router();

  router.get('/', async ctx => {
    const unreadOnly = ctx.query.unread === 'true';
    let query = ctx.auth.db.from('notifications')
      .select('id,kind,title,body,link,severity,read_at,created_at')
      .eq('user_id', ctx.auth.user.id);
    if (unreadOnly) query = query.is('read_at', 'null');
    const rows = await query.order('created_at').limit(Number(ctx.query.limit) || 30).all();

    const { total: unread } = await ctx.auth.db.from('notifications').select('id')
      .eq('user_id', ctx.auth.user.id).is('read_at', 'null').count().run('GET');

    return sendJson(ctx.res, 200, { notifications: rows, unread: unread ?? 0 });
  }, { auth: true });

  router.post('/:id/read', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    await ctx.auth.db.from('notifications').eq('id', id).eq('user_id', ctx.auth.user.id)
      .update({ read_at: new Date().toISOString() });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: true });

  router.post('/read-all', async ctx => {
    await ctx.auth.db.from('notifications').eq('user_id', ctx.auth.user.id).is('read_at', 'null')
      .update({ read_at: new Date().toISOString() });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: true });

  return router;
}
