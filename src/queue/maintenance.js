/**
 * Scheduled maintenance.
 *
 * Housekeeping that keeps the database from accumulating dead weight. Each task
 * is bounded and idempotent, so a missed run is caught up by the next one and
 * a duplicate run is harmless.
 */

import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { registerHandler } from './worker.js';
import { enqueue, QUEUES, reapStale } from './queue.js';
import { logger } from '../core/logger.js';
import { caches } from '../core/cache.js';
import { stopAllPreviews } from '../exec/preview.js';

const RETENTION = {
  aiCacheDays: 7,
  systemEventDays: 14,
  webhookEventDays: 30,
  auditLogDays: 365,
  usageRecordDays: 90,
  completedJobDays: 3
};

registerHandler('maintenance.sweep', async () => {
  if (!hasServiceRole()) return { skipped: 'no service role' };
  const client = serviceClient();
  const results = {};

  const since = days => new Date(Date.now() - days * 86_400_000).toISOString();

  // Expired AI cache entries. The cache is a cost optimisation, not a record.
  results.aiCache = (await client.from('ai_cache')
    .lt('expires_at', new Date().toISOString()).remove().catch(() => [])).length;

  // Observability data past its useful life. Audit logs are kept far longer
  // because they answer questions about what happened, not how fast.
  results.systemEvents = (await client.from('system_events')
    .lt('created_at', since(RETENTION.systemEventDays)).remove().catch(() => [])).length;

  results.webhookEvents = (await client.from('webhook_events')
    .lt('created_at', since(RETENTION.webhookEventDays))
    .in('status', ['processed', 'ignored']).remove().catch(() => [])).length;

  // Finished jobs. The result was already reported to whoever cared.
  results.jobs = (await client.from('jobs')
    .lt('updated_at', since(RETENTION.completedJobDays))
    .in('status', ['completed', 'cancelled']).remove().catch(() => [])).length;

  // Sessions revoked long ago no longer need a row.
  results.sessions = (await client.from('user_sessions')
    .lt('revoked_at', since(30)).remove().catch(() => [])).length;

  // Rate-limit windows that have long since closed.
  results.rateLimits = (await client.from('rate_limits')
    .lt('window_start', since(2)).remove().catch(() => [])).length;

  // Jobs whose worker died mid-run.
  results.reapedJobs = await reapStale().catch(() => 0);

  logger.info('maintenance sweep completed', results);
  return results;
});

/**
 * Cost alerting.
 *
 * Compares the last day against the previous seven and notifies platform
 * admins when spend moves in a way worth looking at.
 */
registerHandler('maintenance.cost_alert', async () => {
  if (!hasServiceRole()) return { skipped: 'no service role' };
  const client = serviceClient();

  const settings = await client.from('system_settings').select('value').eq('key', 'alerts.cost').first();
  const thresholds = settings?.value ?? { daily_increase_percent: 30, notify_admins: true };
  if (thresholds.notify_admins === false) return { skipped: 'alerts disabled' };

  const days = await client.from('usage_daily')
    .select('day,cost_micros,requests,errors')
    .gte('day', new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10))
    .order('day', { ascending: true }).limit(200).all();

  const byDay = new Map();
  for (const row of days) {
    byDay.set(row.day, (byDay.get(row.day) || 0) + Number(row.cost_micros));
  }
  const series = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (series.length < 4) return { skipped: 'not enough history' };

  const latest = series[series.length - 1][1];
  const previous = series.slice(0, -1);
  const average = previous.reduce((sum, [, cost]) => sum + cost, 0) / previous.length;
  if (average <= 0) return { skipped: 'no baseline' };

  const changePercent = Math.round(((latest - average) / average) * 100);
  if (changePercent < (thresholds.daily_increase_percent ?? 30)) {
    return { changePercent, alerted: false };
  }

  const admins = await client.from('platform_admins').select('user_id').limit(20).all();
  const { notify } = await import('../modules/notifications/routes.js');

  for (const admin of admins) {
    await notify({
      userId: admin.user_id,
      kind: 'system',
      severity: 'warning',
      title: `AI cost is up ${changePercent}% today`,
      body: `Yesterday's spend was $${(latest / 1_000_000).toFixed(2)} against a $${(average / 1_000_000).toFixed(2)} daily average.`,
      link: '/admin/costs'
    });
  }

  logger.warn('cost alert raised', { changePercent, latest, average });
  return { changePercent, alerted: true, notified: admins.length };
});

/** Re-index projects whose workspace has drifted from the stored index. */
registerHandler('maintenance.reindex_stale', async () => {
  if (!hasServiceRole()) return { skipped: 'no service role' };
  const client = serviceClient();

  const stale = await client.from('projects')
    .select('id,org_id')
    .eq('index_status', 'stale')
    .is('archived_at', 'null')
    .limit(10).all();

  for (const project of stale) {
    await enqueue({
      kind: 'project.index', queue: QUEUES.index, priority: 200,
      payload: { projectId: project.id, full: false },
      orgId: project.org_id, projectId: project.id
    }).catch(() => {});
  }

  return { queued: stale.length };
});

/**
 * Start the periodic schedule.
 *
 * Deliberately in-process rather than a cron service: the work is small, and a
 * missed run is caught up by the next one. Jobs go through the queue, so with
 * several instances only one worker actually runs each.
 */
export function startMaintenance() {
  if (!hasServiceRole()) return;

  const schedule = (kind, intervalMs) => {
    const timer = setInterval(() => {
      enqueue({ kind, queue: QUEUES.maintenance, priority: 500, maxAttempts: 1 })
        .catch(error => logger.debug('maintenance job not queued', { kind, reason: error?.message }));
    }, intervalMs);
    timer.unref?.();
    return timer;
  };

  schedule('maintenance.sweep', 6 * 3_600_000);
  schedule('maintenance.cost_alert', 12 * 3_600_000);
  schedule('maintenance.reindex_stale', 3_600_000);

  // In-process caches are swept far more often than the database.
  const cacheTimer = setInterval(() => {
    for (const cache of Object.values(caches)) {
      if (cache.map.size > cache.max * 0.9) cache.clear();
    }
  }, 300_000);
  cacheTimer.unref?.();

  logger.info('maintenance schedule started');
}

export { RETENTION };
