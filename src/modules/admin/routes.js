/**
 * Admin dashboard API.
 *
 * Every route here requires platform-admin membership. Reads use the service
 * role deliberately: an administrator's job is to see across tenants, and that
 * is exactly the boundary RLS enforces for everyone else.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, notFound } from '../../core/errors.js';
import { serviceClient } from '../../db/supabase.js';
import { audit, runtimeStats } from '../observability/audit.js';
import { capabilities } from '../../config/env.js';
import { adminModelRoutes } from './models.routes.js';
import { invalidateCatalog, systemSetting } from '../../ai/catalog.js';
import { workerStatus } from '../../queue/worker.js';
import { stats as queueStats } from '../../queue/queue.js';
import { caches } from '../../core/cache.js';

const DAY_MS = 86_400_000;

function dayRange(days) {
  const since = new Date(Date.now() - days * DAY_MS);
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

export function adminRoutes() {
  const router = new Router();

  /** Platform overview: users, revenue, AI spend and system health. */
  router.get('/overview', async ctx => {
    const client = serviceClient();
    const now = Date.now();
    const since30 = new Date(now - 30 * DAY_MS).toISOString();
    const since7 = new Date(now - 7 * DAY_MS).toISOString();
    const since24 = new Date(now - DAY_MS).toISOString();

    const [users, newUsers, activeUsers, orgs, projects, tasks24, failedTasks24, subscriptions, daily] = await Promise.all([
      client.from('profiles').select('id').count().limit(1).run('GET'),
      client.from('profiles').select('id').gte('created_at', since7).count().limit(1).run('GET'),
      client.from('profiles').select('id').gte('last_seen_at', since7).count().limit(1).run('GET'),
      client.from('organizations').select('id').count().limit(1).run('GET'),
      client.from('projects').select('id').is('archived_at', 'null').count().limit(1).run('GET'),
      client.from('tasks').select('id').gte('created_at', since24).count().limit(1).run('GET'),
      client.from('tasks').select('id').eq('status', 'failed').gte('created_at', since24).count().limit(1).run('GET'),
      client.from('subscriptions').select('status,billing_interval,plans(code,name,price_monthly_cents,price_yearly_cents)')
        .in('status', ['active', 'trialing', 'past_due']).limit(1000).all(),
      client.from('usage_daily').select('day,requests,input_tokens,output_tokens,cached_tokens,cost_micros,errors')
        .gte('day', dayRange(30).toISOString().slice(0, 10)).order('day', { ascending: true }).limit(500).all()
    ]);

    // Monthly recurring revenue, normalised across billing intervals.
    let mrrCents = 0;
    const planCounts = {};
    for (const subscription of subscriptions) {
      const plan = subscription.plans;
      if (!plan) continue;
      planCounts[plan.code] = (planCounts[plan.code] || 0) + 1;
      if (subscription.status === 'past_due') continue;
      mrrCents += subscription.billing_interval === 'yearly'
        ? Math.round((plan.price_yearly_cents || 0) / 12)
        : (plan.price_monthly_cents || 0);
    }

    // AI spend, aggregated from the daily rollup rather than the raw ledger.
    const byDay = new Map();
    for (const row of daily) {
      const bucket = byDay.get(row.day) || { day: row.day, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 0, errors: 0 };
      bucket.requests += row.requests;
      bucket.inputTokens += Number(row.input_tokens);
      bucket.outputTokens += Number(row.output_tokens);
      bucket.cachedTokens += Number(row.cached_tokens);
      bucket.costMicros += Number(row.cost_micros);
      bucket.errors += row.errors;
      byDay.set(row.day, bucket);
    }
    const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    const cost30 = series.reduce((sum, day) => sum + day.costMicros, 0);
    const cost7 = series.slice(-7).reduce((sum, day) => sum + day.costMicros, 0);
    const costPrevious7 = series.slice(-14, -7).reduce((sum, day) => sum + day.costMicros, 0);
    const requests30 = series.reduce((sum, day) => sum + day.requests, 0);

    const margin = await systemSetting('billing.margin', { infrastructure_cost_monthly_cents: 0, target_margin: 0.6 });
    const aiCostCents = Math.round(cost30 / 10_000);
    const infraCents = margin.infrastructure_cost_monthly_cents || 0;
    const grossMarginCents = mrrCents - aiCostCents - infraCents;

    return sendJson(ctx.res, 200, {
      users: { total: users.total ?? 0, newLast7Days: newUsers.total ?? 0, activeLast7Days: activeUsers.total ?? 0 },
      organizations: orgs.total ?? 0,
      projects: projects.total ?? 0,
      tasks: { last24h: tasks24.total ?? 0, failedLast24h: failedTasks24.total ?? 0 },
      subscriptions: { active: subscriptions.length, byPlan: planCounts },
      revenue: {
        mrrCents,
        aiCostCents,
        infrastructureCents: infraCents,
        grossMarginCents,
        grossMarginRatio: mrrCents ? Number((grossMarginCents / mrrCents).toFixed(3)) : null,
        targetMargin: margin.target_margin ?? null
      },
      ai: {
        costMicros30d: cost30,
        costMicros7d: cost7,
        costChange7dPercent: costPrevious7 ? Math.round(((cost7 - costPrevious7) / costPrevious7) * 100) : null,
        requests30d: requests30,
        avgCostPerRequestMicros: requests30 ? Math.round(cost30 / requests30) : 0,
        series
      },
      system: { ...runtimeStats.snapshot(), capabilities: capabilities() },
      since: since30
    });
  }, { auth: 'platformAdmin' });

  /** Cost broken down by model, organization and day. */
  router.get('/costs', async ctx => {
    const client = serviceClient();
    const days = Math.min(90, Math.max(1, Number(ctx.query.days) || 30));
    const since = new Date(Date.now() - days * DAY_MS).toISOString();

    const [records, models, orgs] = await Promise.all([
      client.from('usage_records')
        .select('org_id,model_id,model_code,provider_code,category,level,input_tokens,output_tokens,cached_input_tokens,cost_micros,latency_ms,status,created_at')
        .gte('created_at', since).order('created_at').limit(1000).all(),
      client.from('models').select('id,name,code').limit(500).all(),
      client.from('organizations').select('id,name,slug').limit(500).all()
    ]);

    const modelNames = new Map(models.map(m => [m.id, m.name]));
    const orgNames = new Map(orgs.map(o => [o.id, o.name]));

    const byModel = new Map();
    const byOrg = new Map();
    const byCategory = new Map();

    for (const row of records) {
      const cost = Number(row.cost_micros);
      const tokens = row.input_tokens + row.output_tokens;

      const model = byModel.get(row.model_code) || {
        modelCode: row.model_code, modelName: modelNames.get(row.model_id) ?? row.model_code,
        provider: row.provider_code, requests: 0, inputTokens: 0, outputTokens: 0,
        cachedTokens: 0, costMicros: 0, errors: 0, latencyTotal: 0
      };
      model.requests += 1;
      model.inputTokens += row.input_tokens;
      model.outputTokens += row.output_tokens;
      model.cachedTokens += row.cached_input_tokens;
      model.costMicros += cost;
      model.latencyTotal += row.latency_ms;
      if (row.status !== 'ok') model.errors += 1;
      byModel.set(row.model_code, model);

      if (row.org_id) {
        const org = byOrg.get(row.org_id) || { orgId: row.org_id, name: orgNames.get(row.org_id) ?? 'Unknown', requests: 0, tokens: 0, costMicros: 0 };
        org.requests += 1;
        org.tokens += tokens;
        org.costMicros += cost;
        byOrg.set(row.org_id, org);
      }

      const category = byCategory.get(row.category) || { category: row.category || 'unknown', requests: 0, costMicros: 0 };
      category.requests += 1;
      category.costMicros += cost;
      byCategory.set(row.category, category);
    }

    const alerts = [];
    const thresholds = await systemSetting('alerts.cost', { daily_increase_percent: 30, model_token_spike_percent: 50 });
    const totalCost = [...byModel.values()].reduce((sum, model) => sum + model.costMicros, 0);
    for (const model of byModel.values()) {
      const share = totalCost ? model.costMicros / totalCost : 0;
      if (share > 0.6 && byModel.size > 1) {
        alerts.push({ severity: 'warning', message: `${model.modelName} accounts for ${Math.round(share * 100)}% of AI spend.` });
      }
      if (model.requests > 20 && model.errors / model.requests > 0.1) {
        alerts.push({ severity: 'critical', message: `${model.modelName} is failing ${Math.round((model.errors / model.requests) * 100)}% of requests.` });
      }
    }

    return sendJson(ctx.res, 200, {
      days,
      sampled: records.length,
      totals: {
        costMicros: totalCost,
        requests: records.length,
        avgCostPerRequestMicros: records.length ? Math.round(totalCost / records.length) : 0
      },
      byModel: [...byModel.values()]
        .map(model => ({ ...model, avgLatencyMs: model.requests ? Math.round(model.latencyTotal / model.requests) : 0, latencyTotal: undefined }))
        .sort((a, b) => b.costMicros - a.costMicros),
      byOrganization: [...byOrg.values()].sort((a, b) => b.costMicros - a.costMicros).slice(0, 50),
      byCategory: [...byCategory.values()].sort((a, b) => b.costMicros - a.costMicros),
      alerts,
      thresholds
    });
  }, { auth: 'platformAdmin' });

  // ─── users ────────────────────────────────────────────────────────────────

  router.get('/users', async ctx => {
    const client = serviceClient();
    let query = client.from('profiles')
      .select('id,email,full_name,username,avatar_url,created_at,last_seen_at,suspended_at,suspension_reason');
    if (ctx.query.q) query = query.like('email', String(ctx.query.q).slice(0, 60));

    const { rows, total } = await query.order('created_at').limit(Math.min(100, Number(ctx.query.limit) || 50)).page();
    return sendJson(ctx.res, 200, {
      users: rows.map(row => ({
        id: row.id, email: row.email, fullName: row.full_name, username: row.username,
        avatarUrl: row.avatar_url, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
        suspended: Boolean(row.suspended_at), suspensionReason: row.suspension_reason
      })),
      total: total ?? rows.length
    });
  }, { auth: 'platformAdmin' });

  router.get('/users/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const client = serviceClient();
    const since = new Date(Date.now() - 30 * DAY_MS).toISOString();

    const [profile, memberships, tasks, usage, sessions, events] = await Promise.all([
      client.from('profiles').select('*').eq('id', id).first(),
      client.from('organization_members').select('role,organizations(id,name,slug,is_personal)').eq('user_id', id).limit(50).all(),
      client.from('tasks').select('id,title,status,created_at,spent_micros').eq('user_id', id).order('created_at').limit(20).all(),
      client.from('usage_records').select('input_tokens,output_tokens,cost_micros,model_code,status').eq('user_id', id).gte('created_at', since).limit(1000).all(),
      client.from('user_sessions').select('id,ip,device,last_active_at,revoked_at').eq('user_id', id).order('last_active_at').limit(20).all(),
      client.from('audit_logs').select('action,severity,ip,created_at').eq('actor_id', id).order('created_at').limit(30).all()
    ]);

    if (!profile) throw notFound('User not found');

    const totals = usage.reduce((acc, row) => ({
      inputTokens: acc.inputTokens + row.input_tokens,
      outputTokens: acc.outputTokens + row.output_tokens,
      costMicros: acc.costMicros + Number(row.cost_micros),
      requests: acc.requests + 1,
      errors: acc.errors + (row.status === 'ok' ? 0 : 1)
    }), { inputTokens: 0, outputTokens: 0, costMicros: 0, requests: 0, errors: 0 });

    return sendJson(ctx.res, 200, {
      user: {
        id: profile.id, email: profile.email, fullName: profile.full_name, username: profile.username,
        avatarUrl: profile.avatar_url, timezone: profile.timezone, locale: profile.locale,
        createdAt: profile.created_at, lastSeenAt: profile.last_seen_at,
        suspended: Boolean(profile.suspended_at), suspensionReason: profile.suspension_reason
      },
      organizations: memberships.filter(m => m.organizations).map(m => ({ ...m.organizations, role: m.role })),
      recentTasks: tasks.map(task => ({ id: task.id, title: task.title, status: task.status, createdAt: task.created_at, costMicros: Number(task.spent_micros) })),
      usage30d: totals,
      sessions,
      securityEvents: events
    });
  }, { auth: 'platformAdmin' });

  router.post('/users/:id/suspend', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const body = parse(t.object({
      suspended: t.boolean({ required: true }),
      reason: t.string({ max: 300, truncate: true, default: '' })
    }), await ctx.json());

    if (id === ctx.auth.user.id) throw badRequest('You cannot suspend your own account');

    const [row] = await serviceClient().from('profiles').eq('id', id).update({
      suspended_at: body.suspended ? new Date().toISOString() : null,
      suspension_reason: body.suspended ? body.reason : null
    });
    if (!row) throw notFound('User not found');

    audit.record({
      actorId: ctx.auth.user.id, actorType: 'admin',
      action: body.suspended ? 'admin.user_suspended' : 'admin.user_reactivated',
      resource: 'user', resourceId: id, severity: 'critical', metadata: { reason: body.reason }
    });
    return sendJson(ctx.res, 200, { ok: true, suspended: body.suspended });
  }, { auth: 'platformAdmin' });

  // ─── plans, flags and settings ────────────────────────────────────────────

  router.get('/plans', async ctx => {
    const rows = await serviceClient().from('plans').select('*').order('sort_order', { ascending: true }).limit(50).all();
    return sendJson(ctx.res, 200, { plans: rows });
  }, { auth: 'platformAdmin' });

  router.patch('/plans/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const body = parse(t.object({
      name: t.string({ max: 60 }),
      description: t.string({ max: 300, truncate: true }),
      priceMonthlyCents: t.integer({ min: 0, max: 10_000_000 }),
      priceYearlyCents: t.integer({ min: 0, max: 100_000_000 }),
      includedCreditsCents: t.integer({ min: 0, max: 10_000_000 }),
      maxProjects: t.integer({ min: 0, max: 100_000 }),
      maxTasksPerDay: t.integer({ min: 0, max: 1_000_000 }),
      maxTokensPerMonth: t.integer({ min: 0 }),
      maxCostPerMonthCents: t.integer({ min: 0 }),
      maxConcurrentAgents: t.integer({ min: 1, max: 200 }),
      maxRepoMb: t.integer({ min: 1, max: 100_000 }),
      requestsPerMinute: t.integer({ min: 1, max: 100_000 }),
      allowedModelTiers: t.array(t.string({ max: 12 }), { max: 5 }),
      features: t.object({}, { passthrough: true }),
      isPublic: t.boolean()
    }), await ctx.json());

    const map = {
      name: 'name', description: 'description', priceMonthlyCents: 'price_monthly_cents',
      priceYearlyCents: 'price_yearly_cents', includedCreditsCents: 'included_credits_cents',
      maxProjects: 'max_projects', maxTasksPerDay: 'max_tasks_per_day',
      maxTokensPerMonth: 'max_tokens_per_month', maxCostPerMonthCents: 'max_cost_per_month_cents',
      maxConcurrentAgents: 'max_concurrent_agents', maxRepoMb: 'max_repo_mb',
      requestsPerMinute: 'requests_per_minute', allowedModelTiers: 'allowed_model_tiers',
      features: 'features', isPublic: 'is_public'
    };
    const patch = {};
    for (const [key, column] of Object.entries(map)) if (body[key] !== undefined) patch[column] = body[key];
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const [row] = await serviceClient().from('plans').eq('id', id).update(patch);
    if (!row) throw notFound('Plan not found');

    caches.settings.delete('public:plans');
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.plan_updated', resourceId: id, severity: 'critical', metadata: { fields: Object.keys(patch) } });
    return sendJson(ctx.res, 200, { plan: row });
  }, { auth: 'platformAdmin' });

  router.get('/feature-flags', async ctx => {
    const rows = await serviceClient().from('feature_flags').select('*').limit(100).all();
    return sendJson(ctx.res, 200, { flags: rows });
  }, { auth: 'platformAdmin' });

  router.patch('/feature-flags/:key', async ctx => {
    const key = String(ctx.params.key).slice(0, 60);
    const body = parse(t.object({
      enabled: t.boolean(),
      rolloutPercentage: t.integer({ min: 0, max: 100 }),
      requiredPlanCodes: t.array(t.string({ max: 30 }), { max: 10 })
    }), await ctx.json());

    const patch = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.rolloutPercentage !== undefined) patch.rollout_percentage = body.rolloutPercentage;
    if (body.requiredPlanCodes !== undefined) patch.required_plan_codes = body.requiredPlanCodes;
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const [row] = await serviceClient().from('feature_flags').eq('key', key).update(patch);
    if (!row) throw notFound('Feature flag not found');

    caches.settings.delete('system:flags');
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.flag_updated', resourceId: key, severity: 'warning', metadata: patch });
    return sendJson(ctx.res, 200, { flag: row });
  }, { auth: 'platformAdmin' });

  router.get('/settings', async ctx => {
    const rows = await serviceClient().from('system_settings').select('*').limit(100).all();
    return sendJson(ctx.res, 200, { settings: rows });
  }, { auth: 'platformAdmin' });

  router.put('/settings/:key', async ctx => {
    const key = String(ctx.params.key).slice(0, 60);
    const body = await ctx.json();
    if (!body || typeof body.value !== 'object') throw badRequest('A JSON `value` object is required');

    const row = await serviceClient().insert('system_settings', {
      key, value: body.value, updated_by: ctx.auth.user.id
    }, { upsert: true, onConflict: 'key' });

    invalidateCatalog();
    caches.settings.clear();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.setting_updated', resourceId: key, severity: 'critical' });
    return sendJson(ctx.res, 200, { setting: row });
  }, { auth: 'platformAdmin' });

  // ─── logs and system health ───────────────────────────────────────────────

  router.get('/audit-logs', async ctx => {
    const client = serviceClient();
    let query = client.from('audit_logs').select('*');
    if (ctx.query.action) query = query.like('action', String(ctx.query.action).slice(0, 60));
    if (ctx.query.severity) query = query.eq('severity', String(ctx.query.severity).slice(0, 20));
    if (ctx.query.actorId) query = query.eq('actor_id', parse(uuid({ required: true }), ctx.query.actorId));

    const { rows, total } = await query.order('created_at').limit(Math.min(200, Number(ctx.query.limit) || 100)).page();
    return sendJson(ctx.res, 200, { logs: rows, total: total ?? rows.length });
  }, { auth: 'platformAdmin' });

  router.get('/system', async ctx => {
    const [queue, events] = await Promise.all([
      queueStats().catch(() => ({ pending: 0, running: 0, failed24h: 0 })),
      serviceClient().from('system_events')
        .select('kind,name,status,duration_ms,created_at')
        .gte('created_at', new Date(Date.now() - DAY_MS).toISOString())
        .neq('status', 'ok').order('created_at').limit(50).all().catch(() => [])
    ]);

    return sendJson(ctx.res, 200, {
      runtime: runtimeStats.snapshot(),
      capabilities: capabilities(),
      worker: workerStatus(),
      queue,
      recentFailures: events,
      caches: Object.fromEntries(Object.entries(caches).map(([name, cache]) => [name, cache.stats()]))
    });
  }, { auth: 'platformAdmin' });

  router.use('/ai', adminModelRoutes());

  return router;
}
