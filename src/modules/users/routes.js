/**
 * Profile, preferences, sessions, usage and account lifecycle.
 * Everything the profile page needs, and nothing that belongs to another user.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, forbidden, notConfigured, notFound } from '../../core/errors.js';
import { hasServiceRole, serviceClient } from '../../db/supabase.js';
import { audit } from '../observability/audit.js';
import { invalidateIdentity } from '../auth/service.js';
import { forget } from './presence.js';
import { selectableModels } from '../../ai/catalog.js';
import { avatarRoute } from '../uploads/routes.js';
import { getPlanUsage } from '../billing/usage.js';

const aiPreferences = t.object({
  defaultModelId: t.string({ max: 40 }),
  reasoningLevel: t.enum(['auto', 'none', 'low', 'medium', 'high']),
  autonomy: t.enum(['safe', 'confirm', 'autonomous']),
  verbosity: t.enum(['concise', 'balanced', 'detailed']),
  autoTest: t.boolean(),
  autoCommit: t.boolean(),
  autoReview: t.boolean(),
  budgetMicros: t.integer({ min: 1000, max: 50_000_000 }),
  codingStyle: t.string({ max: 500, truncate: true })
});

const profileUpdate = t.object({
  fullName: t.string({ max: 80, truncate: true }),
  username: t.string({ max: 32, pattern: /^[a-z0-9_-]{3,32}$/, patternMessage: 'may contain lowercase letters, numbers, dash and underscore' }),
  avatarUrl: t.string({ max: 500 }),
  timezone: t.string({ max: 60 }),
  locale: t.enum(['en', 'uz', 'ru', 'ko']),
  experienceLevel: t.enum(['beginner', 'intermediate', 'advanced', 'expert']),
  primaryLanguages: t.array(t.string({ max: 30 }), { max: 12 }),
  preferredFrameworks: t.array(t.string({ max: 30 }), { max: 12 }),
  aiPreferences,
  notificationPreferences: t.object({
    task_completed: t.boolean(), task_failed: t.boolean(), approval_required: t.boolean(),
    security: t.boolean(), billing: t.boolean(), weekly_summary: t.boolean()
  })
});

const COLUMN_MAP = {
  fullName: 'full_name', username: 'username', avatarUrl: 'avatar_url', timezone: 'timezone',
  locale: 'locale', experienceLevel: 'experience_level', primaryLanguages: 'primary_languages',
  preferredFrameworks: 'preferred_frameworks', aiPreferences: 'ai_preferences',
  notificationPreferences: 'notification_preferences'
};

export function userRoutes() {
  const router = new Router();

  // A profile picture is a file, not a URL, so it has its own upload route.
  avatarRoute(router);

  /**
   * The models this user may choose.
   *
   * The chat panel's picker is populated from here rather than from the full
   * catalogue, so it can only ever offer what an administrator has opened and
   * the organization's plan can reach.
   */
  router.get('/models', async ctx => {
    const { plan } = await getPlanUsage(ctx.auth);
    const models = await selectableModels({ allowedTiers: plan.allowedModelTiers }).catch(() => []);
    const preferred = ctx.auth.profile?.ai_preferences?.defaultModelId ?? null;

    return sendJson(ctx.res, 200, {
      models,
      // A preference for a model that has since been closed is reported as
      // absent, so the panel shows "automatic" rather than a stale name.
      defaultModelId: models.some(model => model.id === preferred) ? preferred : null
    });
  }, { auth: true });

  router.patch('/profile', async ctx => {
    const body = parse(profileUpdate, await ctx.json());

    // A model preference is checked here rather than silently ignored at
    // routing time, so choosing a closed model fails visibly instead of
    // appearing to work.
    if (body.aiPreferences?.defaultModelId) {
      const { plan } = await getPlanUsage(ctx.auth);
      const models = await selectableModels({ allowedTiers: plan.allowedModelTiers }).catch(() => []);
      if (!models.some(model => model.id === body.aiPreferences.defaultModelId)) {
        throw badRequest('That model is not available on your plan. Choose one from the model list, or leave it automatic.');
      }
    }

    const patch = {};
    for (const [key, column] of Object.entries(COLUMN_MAP)) {
      if (body[key] !== undefined) patch[column] = body[key];
    }
    if (!Object.keys(patch).length) throw badRequest('No profile fields were supplied');

    const [row] = await ctx.auth.db.from('profiles').eq('id', ctx.auth.user.id).update(patch);
    audit.record({ orgId: ctx.auth.org?.id, actorId: ctx.auth.user.id, action: 'profile.updated', resource: 'profile', metadata: { fields: Object.keys(patch) } });
    return sendJson(ctx.res, 200, { profile: row });
  }, { auth: true });

  router.post('/profile/onboarded', async ctx => {
    const [row] = await ctx.auth.db.from('profiles').eq('id', ctx.auth.user.id).update({ onboarded_at: new Date().toISOString() });
    return sendJson(ctx.res, 200, { profile: row });
  }, { auth: true });

  /** Token, cost and task totals for the current billing period. */
  router.get('/usage', async ctx => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = await ctx.auth.db
      .from('usage_records')
      .select('input_tokens,output_tokens,cached_input_tokens,cost_micros,model_code,created_at,status')
      .eq('user_id', ctx.auth.user.id)
      .gte('created_at', since)
      .order('created_at')
      .limit(1000)
      .all();

    const byModel = new Map();
    const byDay = new Map();
    let input = 0, output = 0, cached = 0, cost = 0, errors = 0;

    for (const row of rows) {
      input += row.input_tokens; output += row.output_tokens;
      cached += row.cached_input_tokens; cost += Number(row.cost_micros);
      if (row.status !== 'ok') errors += 1;

      const model = byModel.get(row.model_code) || { model: row.model_code, requests: 0, tokens: 0, costMicros: 0 };
      model.requests += 1;
      model.tokens += row.input_tokens + row.output_tokens;
      model.costMicros += Number(row.cost_micros);
      byModel.set(row.model_code, model);

      const day = row.created_at.slice(0, 10);
      const bucket = byDay.get(day) || { day, tokens: 0, costMicros: 0, requests: 0 };
      bucket.requests += 1;
      bucket.tokens += row.input_tokens + row.output_tokens;
      bucket.costMicros += Number(row.cost_micros);
      byDay.set(day, bucket);
    }

    const { total: taskCount } = await ctx.auth.db.from('tasks').select('id').eq('user_id', ctx.auth.user.id).count().run('GET');
    const { total: projectCount } = await ctx.auth.db.from('projects').select('id').eq('org_id', ctx.auth.org.id).count().run('GET');

    return sendJson(ctx.res, 200, {
      period: { since, days: 30 },
      totals: { inputTokens: input, outputTokens: output, cachedTokens: cached, costMicros: cost, requests: rows.length, errors },
      tasks: taskCount ?? 0,
      projects: projectCount ?? 0,
      byModel: [...byModel.values()].sort((a, b) => b.costMicros - a.costMicros),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
    });
  }, { auth: true });

  router.get('/sessions', async ctx => {
    const rows = await ctx.auth.db.from('user_sessions').select('id,ip,user_agent,device,location,last_active_at,created_at,revoked_at')
      .eq('user_id', ctx.auth.user.id).order('last_active_at').limit(50).all();
    return sendJson(ctx.res, 200, { sessions: rows });
  }, { auth: true });

  router.delete('/sessions/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const [row] = await ctx.auth.db.from('user_sessions').eq('id', id).eq('user_id', ctx.auth.user.id)
      .update({ revoked_at: new Date().toISOString() });
    if (!row) throw notFound('Session not found');

    // Clear the cached revocation answer so the change takes effect at once
    // rather than after the cache expires.
    forget(ctx.auth.user.id, null);

    audit.record({
      actorId: ctx.auth.user.id, action: 'session.revoked',
      resource: 'session', resourceId: id, severity: 'warning', ip: ctx.ip
    });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: true });

  router.get('/security-events', async ctx => {
    const rows = await ctx.auth.db.from('audit_logs').select('id,action,resource,severity,ip,created_at,metadata')
      .eq('actor_id', ctx.auth.user.id).order('created_at').limit(50).all();
    return sendJson(ctx.res, 200, { events: rows });
  }, { auth: true });

  /** Machine-readable export of everything the account owns. */
  router.get('/export', async ctx => {
    const db = ctx.auth.db;
    const [profile, projects, tasks, conversations, memory] = await Promise.all([
      db.from('profiles').select('*').eq('id', ctx.auth.user.id).first(),
      db.from('projects').select('id,name,slug,description,language,framework,created_at').eq('org_id', ctx.auth.org.id).limit(500).all(),
      db.from('tasks').select('id,title,objective,status,mode,created_at,finished_at').eq('user_id', ctx.auth.user.id).order('created_at').limit(1000).all(),
      db.from('conversations').select('id,title,mode,created_at').eq('user_id', ctx.auth.user.id).order('created_at').limit(500).all(),
      db.from('project_memory').select('scope,kind,key,content,created_at').eq('user_id', ctx.auth.user.id).limit(500).all()
    ]);
    ctx.res.setHeader('Content-Disposition', `attachment; filename="diroxcode-export-${Date.now()}.json"`);
    audit.record({ actorId: ctx.auth.user.id, action: 'account.exported', severity: 'warning' });
    return sendJson(ctx.res, 200, { exportedAt: new Date().toISOString(), profile, projects, tasks, conversations, memory });
  }, { auth: true, rateLimit: 'heavy' });

  /**
   * Account deletion. Requires the user to type their email, and removes the
   * auth user so the cascade clears every owned row.
   */
  router.post('/delete-account', async ctx => {
    const body = parse(t.object({ confirmEmail: t.string({ required: true, max: 254, lower: true }) }), await ctx.json());
    if (body.confirmEmail !== String(ctx.auth.user.email || '').toLowerCase()) {
      throw badRequest('Type your account email exactly to confirm deletion');
    }
    if (!hasServiceRole()) throw notConfigured('Account deletion (SUPABASE_SERVICE_ROLE_KEY)');

    const ownedOrgs = await ctx.auth.db.from('organizations').select('id,is_personal').eq('owner_id', ctx.auth.user.id).all();
    const sharedOrg = ownedOrgs.find(org => !org.is_personal);
    if (sharedOrg) throw forbidden('Transfer ownership of your shared organizations before deleting your account');

    audit.record({ actorId: ctx.auth.user.id, action: 'account.deleted', severity: 'critical', ip: ctx.ip });
    await audit.flush();

    await serviceClient().request(`/auth/v1/admin/users/${ctx.auth.user.id}`, { method: 'DELETE' });
    invalidateIdentity(ctx.auth.accessToken);
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: true, rateLimit: 'heavy' });

  return router;
}
