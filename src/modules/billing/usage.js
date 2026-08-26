/**
 * Plan limits and current consumption.
 *
 * This is the single place that answers "may this organization do one more of
 * X?", so the agent, the project routes and the billing page all agree.
 */

import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { quotaExceeded } from '../../core/errors.js';
import { TtlCache } from '../../core/cache.js';
import { shapePlan } from './routes.js';

const usageCache = new TtlCache({ max: 500, ttlMs: 20_000 });

/** Fall back to the most restrictive sensible limits if no plan is attached. */
const FALLBACK_PLAN = {
  code: 'free', name: 'Free', maxProjects: 2, maxTasksPerDay: 15,
  maxTokensPerMonth: 1_000_000, maxCostPerMonthCents: 100, maxConcurrentAgents: 1,
  maxRepoMb: 100, requestsPerMinute: 30, allowedModelTiers: ['level0', 'level1'],
  features: {}, includedCreditsCents: 0
};

export async function getPlanUsage(auth, { fresh = false } = {}) {
  const key = `plan:${auth.org.id}`;
  if (fresh) usageCache.delete(key);

  return usageCache.wrap(key, async () => {
    const subscription = await auth.db
      .from('subscriptions')
      .select('id,status,billing_interval,current_period_start,current_period_end,cancel_at_period_end,credits_cents,plans(*)')
      .eq('org_id', auth.org.id)
      .in('status', ['trialing', 'active', 'past_due'])
      .first();

    const plan = subscription?.plans ? shapePlan(subscription.plans) : FALLBACK_PLAN;
    const periodStart = subscription?.current_period_start || new Date(Date.now() - 30 * 86_400_000).toISOString();

    // The rollup function reads across users in the org, so it needs the
    // service role; without it we report the caller's own usage instead.
    let consumption = { requests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, tasks: 0 };
    if (hasServiceRole()) {
      const rows = await serviceClient().rpc('org_period_usage', { p_org: auth.org.id, p_since: periodStart });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) {
        consumption = {
          requests: Number(row.requests || 0),
          inputTokens: Number(row.input_tokens || 0),
          outputTokens: Number(row.output_tokens || 0),
          costMicros: Number(row.cost_micros || 0),
          tasks: Number(row.tasks || 0)
        };
      }
    }

    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const { total: tasksToday } = await auth.db.from('tasks').select('id')
      .eq('org_id', auth.org.id).gte('created_at', startOfDay.toISOString()).count().run('GET');
    const { total: projectCount } = await auth.db.from('projects').select('id')
      .eq('org_id', auth.org.id).is('archived_at', 'null').count().run('GET');
    const { total: runningAgents } = await auth.db.from('tasks').select('id')
      .eq('org_id', auth.org.id).in('status', ['queued', 'planning', 'running', 'testing']).count().run('GET');

    return {
      plan,
      subscription: subscription ? {
        id: subscription.id, status: subscription.status, interval: subscription.billing_interval,
        periodStart: subscription.current_period_start, periodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end, creditsCents: subscription.credits_cents
      } : null,
      usage: {
        ...consumption,
        totalTokens: consumption.inputTokens + consumption.outputTokens,
        tasksToday: tasksToday ?? 0,
        projects: projectCount ?? 0,
        runningAgents: runningAgents ?? 0
      },
      limits: {
        projects: plan.maxProjects,
        tasksPerDay: plan.maxTasksPerDay,
        tokensPerMonth: plan.maxTokensPerMonth,
        costPerMonthCents: plan.maxCostPerMonthCents,
        concurrentAgents: plan.maxConcurrentAgents,
        repoMb: plan.maxRepoMb
      }
    };
  });
}

/**
 * Assert that one more unit of `what` is within plan.
 * @param {'project'|'task'|'agent'|'tokens'|'cost'} what
 */
export async function assertWithinPlan(auth, what) {
  const { plan, usage, limits } = await getPlanUsage(auth);

  const checks = {
    project: [limits.projects, usage.projects, `Your ${plan.name} plan includes ${limits.projects} projects. Archive one or upgrade to add another.`],
    task: [limits.tasksPerDay, usage.tasksToday, `Your ${plan.name} plan allows ${limits.tasksPerDay} tasks per day. The limit resets at midnight UTC.`],
    agent: [limits.concurrentAgents, usage.runningAgents, `Your ${plan.name} plan allows ${limits.concurrentAgents} agent${limits.concurrentAgents === 1 ? '' : 's'} at a time. Wait for the running task to finish or stop it.`],
    tokens: [limits.tokensPerMonth, usage.totalTokens, `Your ${plan.name} plan includes ${limits.tokensPerMonth} tokens per month.`],
    cost: [limits.costPerMonthCents, Math.round(usage.costMicros / 10_000), `Your ${plan.name} plan has a monthly AI spend cap that has been reached.`]
  };

  const check = checks[what];
  if (!check) return { allowed: true };
  const [limit, used, message] = check;
  if (limit === null || limit === undefined) return { allowed: true, unlimited: true };
  if (used >= limit) throw quotaExceeded(message, { limit, used, plan: plan.code, resource: what });
  return { allowed: true, limit, used, remaining: limit - used };
}

export function invalidatePlanUsage(orgId) { usageCache.delete(`plan:${orgId}`); }

export { FALLBACK_PLAN };
