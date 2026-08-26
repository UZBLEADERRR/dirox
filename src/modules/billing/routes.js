/**
 * Billing surface.
 *
 * Plans are catalogue data the admin owns; this module reads them and reports
 * the organization's current subscription and usage against its limits.
 * Payment provider integration is added on top of this in the billing service.
 */

import { Router, sendJson } from '../../core/http.js';
import { anonClient } from '../../db/supabase.js';
import { caches } from '../../core/cache.js';
import { capabilities } from '../../config/env.js';
import { getPlanUsage } from './usage.js';

function shapePlan(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    priceMonthlyCents: row.price_monthly_cents,
    priceYearlyCents: row.price_yearly_cents,
    currency: row.currency,
    includedCreditsCents: row.included_credits_cents,
    maxProjects: row.max_projects,
    maxTasksPerDay: row.max_tasks_per_day,
    maxTokensPerMonth: row.max_tokens_per_month === null ? null : Number(row.max_tokens_per_month),
    maxCostPerMonthCents: row.max_cost_per_month_cents,
    maxConcurrentAgents: row.max_concurrent_agents,
    maxRepoMb: row.max_repo_mb,
    requestsPerMinute: row.requests_per_minute,
    allowedModelTiers: row.allowed_model_tiers,
    features: row.features,
    isDefault: row.is_default
  };
}

export function billingRoutes() {
  const router = new Router();

  /** Public pricing. Cached briefly so the landing page is cheap to serve. */
  router.get('/plans', async ctx => {
    const plans = await caches.settings.wrap('public:plans', async () => {
      const rows = await anonClient().from('plans').select('*').eq('is_public', true)
        .order('sort_order', { ascending: true }).limit(20).all();
      return rows.map(shapePlan);
    }, 120_000);
    ctx.res.setHeader('Cache-Control', 'public, max-age=120');
    return sendJson(ctx.res, 200, { plans });
  }, { auth: false });

  /** What this organization is on, and how much of it is used. */
  router.get('/subscription', async ctx => {
    const usage = await getPlanUsage(ctx.auth);
    return sendJson(ctx.res, 200, {
      ...usage,
      paymentsEnabled: capabilities().billing
    });
  }, { auth: true });

  router.get('/invoices', async ctx => {
    const rows = await ctx.auth.db.from('invoices')
      .select('id,number,status,total_cents,currency,period_start,period_end,hosted_url,pdf_url,issued_at,paid_at')
      .eq('org_id', ctx.auth.org.id).order('created_at').limit(50).all();
    return sendJson(ctx.res, 200, { invoices: rows });
  }, { auth: 'orgAdmin' });

  return router;
}

export { shapePlan };
