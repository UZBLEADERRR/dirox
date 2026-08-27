/**
 * Connecting a Supabase project.
 *
 * Unlike GitHub there is no OAuth flow to hide behind: the user pastes
 * credentials from their own dashboard. So the route does the two things that
 * make pasting credentials tolerable — it checks them before storing, and it
 * never gives them back.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t } from '../../core/validate.js';
import { badRequest } from '../../core/errors.js';
import { saveConnection, getConnection, revokeConnection } from './supabase.js';
import { audit } from '../observability/audit.js';

const connectSchema = t.object({
  projectUrl: t.string({ required: true, max: 200 }),
  serviceKey: t.string({ max: 4000, trim: false }),
  anonKey: t.string({ max: 4000, trim: false }),
  connectionString: t.string({ max: 1000, trim: false })
});

/** Everything a client may know: what is connected, never what unlocks it. */
function shape(connection) {
  if (!connection) return null;
  return {
    connected: true,
    ref: connection.ref,
    projectUrl: connection.projectUrl,
    database: connection.database ?? null,
    host: connection.host ?? null,
    canRunSql: Boolean(connection.hasDatabase),
    canUseRest: Boolean(connection.hasServiceKey),
    connectedAt: connection.connectedAt
  };
}

export function supabaseRoutes() {
  const router = new Router();

  router.get('/', async ctx => {
    const connection = await getConnection(ctx.auth.user.id);
    return sendJson(ctx.res, 200, { supabase: shape(connection) ?? { connected: false } });
  }, { auth: true });

  router.post('/', async ctx => {
    const body = parse(connectSchema, await ctx.json());
    if (!body.serviceKey && !body.connectionString) {
      throw badRequest('Give at least a service role key or a database connection string — without one there is nothing to connect to.');
    }

    // Both are verified against the real project before anything is written,
    // so a typo fails here rather than three tool calls into a task.
    const result = await saveConnection(ctx.auth.user.id, body);

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'integration.connected',
      resource: 'supabase', resourceId: result.ref,
      metadata: { sql: Boolean(body.connectionString), rest: Boolean(body.serviceKey) }
    });

    const connection = await getConnection(ctx.auth.user.id);
    return sendJson(ctx.res, 201, { supabase: shape(connection) });
  }, { auth: 'write', rateLimit: 'heavy' });

  router.delete('/', async ctx => {
    await revokeConnection(ctx.auth.user.id);
    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'integration.revoked',
      resource: 'supabase', resourceId: ctx.auth.user.id, metadata: {}
    });
    ctx.res.statusCode = 204;
    ctx.res.end();
  }, { auth: 'write' });

  return router;
}
