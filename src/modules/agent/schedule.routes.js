/**
 * Schedules over HTTP.
 *
 * A schedule is a task waiting for a time, so the shape mirrors a task: an
 * objective, a mode, a project. What it adds is when, in whose timezone, and
 * how much the run may do without anybody present to approve it — which is the
 * one field here that is a security decision rather than a preference.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, notFound, forbidden } from '../../core/errors.js';
import { isValidCron, nextRun, describeCron } from '../../core/cron.js';
import { computeNextRun } from '../../queue/scheduler.js';
import { audit } from '../observability/audit.js';
import { TRUST } from '../../agent/permissions.js';

const MODES = ['ask', 'edit', 'agent', 'autopilot', 'review', 'debug', 'plan'];

/** A timezone the platform actually knows, checked rather than trusted. */
function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    mode: row.mode,
    cron: row.cron,
    timezone: row.timezone,
    description: safeDescribe(row.cron, row.timezone),
    enabled: row.enabled,
    trust: row.trust,
    budgetMicros: Number(row.budget_micros),
    projectId: row.project_id,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastTaskId: row.last_task_id,
    runCount: row.run_count,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at
  };
}

/** A stored expression can be older than the parser; never fail a list for it. */
function safeDescribe(cron, timezone) {
  try { return describeCron(cron, timezone); } catch { return cron; }
}

export function scheduleRoutes() {
  const router = new Router();

  const body = t.object({
    name: t.string({ required: true, max: 120 }),
    objective: t.string({ required: true, max: 4000 }),
    cron: t.string({ required: true, max: 120 }),
    timezone: t.string({ max: 60, default: 'UTC' }),
    mode: t.enum(MODES, { default: 'agent' }),
    projectId: uuid(),
    trust: t.enum([TRUST.SAFE, TRUST.CONFIRM, TRUST.AUTONOMOUS], { default: TRUST.CONFIRM }),
    budgetMicros: t.integer({ min: 1000, max: 50_000_000, default: 100_000 }),
    enabled: t.boolean({ default: true })
  });

  function validate(input) {
    if (!isValidCron(input.cron)) {
      throw badRequest(`"${input.cron}" is not a schedule. Use five fields — minute hour day month weekday — or a shorthand like @daily.`);
    }
    if (!validTimezone(input.timezone)) {
      throw badRequest(`"${input.timezone}" is not a timezone this platform knows. Use something like Asia/Tashkent.`);
    }
    // A schedule that will never fire is a schedule somebody will wait for.
    if (!nextRun(input.cron, { timeZone: input.timezone })) {
      throw badRequest(`"${input.cron}" will never occur — check the day and month.`);
    }
  }

  router.get('/', async ctx => {
    const rows = await ctx.auth.db.from('schedules')
      .select('*')
      .eq('org_id', ctx.auth.org.id)
      .order('created_at', { ascending: false })
      .limit(100)
      .all();

    return sendJson(ctx.res, 200, { schedules: rows.map(shape) });
  }, { auth: true });

  router.post('/', async ctx => {
    const input = parse(body, await ctx.json());
    validate(input);

    /*
       An autonomous schedule is a standing grant.

       Approving one action while watching is a different act from letting
       something run every morning unattended, so raising a schedule that far
       is limited to somebody who can act for the organisation.
    */
    if (input.trust === TRUST.AUTONOMOUS && !['owner', 'admin'].includes(ctx.auth.role)) {
      throw forbidden('Only an owner or admin can create a schedule that runs autonomously.');
    }

    const next = nextRun(input.cron, { timeZone: input.timezone });

    const row = await ctx.auth.db.insert('schedules', {
      org_id: ctx.auth.org.id,
      user_id: ctx.auth.user.id,
      project_id: input.projectId ?? null,
      name: input.name,
      objective: input.objective,
      mode: input.mode,
      cron: input.cron,
      timezone: input.timezone,
      trust: input.trust,
      budget_micros: input.budgetMicros,
      enabled: input.enabled,
      next_run_at: input.enabled ? next.toISOString() : null
    }, { returning: true });

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id,
      action: 'schedule.created', resource: 'schedule', resourceId: row.id,
      severity: 'info', metadata: { cron: input.cron, trust: input.trust, mode: input.mode }
    });

    return sendJson(ctx.res, 201, { schedule: shape(row) });
  }, { auth: 'write' });

  router.patch('/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const existing = await ctx.auth.db.from('schedules').select('*').eq('id', id).first();
    if (!existing) throw notFound('Schedule not found');

    const patch = parse(t.object({
      name: t.string({ max: 120 }),
      objective: t.string({ max: 4000 }),
      cron: t.string({ max: 120 }),
      timezone: t.string({ max: 60 }),
      mode: t.enum(MODES),
      trust: t.enum([TRUST.SAFE, TRUST.CONFIRM, TRUST.AUTONOMOUS]),
      budgetMicros: t.integer({ min: 1000, max: 50_000_000 }),
      enabled: t.boolean()
    }), await ctx.json());

    const merged = { ...existing, ...patch, timezone: patch.timezone ?? existing.timezone, cron: patch.cron ?? existing.cron };
    if (patch.cron || patch.timezone) validate({ cron: merged.cron, timezone: merged.timezone });

    if (patch.trust === TRUST.AUTONOMOUS && !['owner', 'admin'].includes(ctx.auth.role)) {
      throw forbidden('Only an owner or admin can let a schedule run autonomously.');
    }

    const update = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.objective !== undefined) update.objective = patch.objective;
    if (patch.mode !== undefined) update.mode = patch.mode;
    if (patch.trust !== undefined) update.trust = patch.trust;
    if (patch.budgetMicros !== undefined) update.budget_micros = patch.budgetMicros;
    if (patch.cron !== undefined) update.cron = patch.cron;
    if (patch.timezone !== undefined) update.timezone = patch.timezone;

    if (patch.enabled !== undefined) {
      update.enabled = patch.enabled;
      // Re-enabling clears the failure count: whatever was wrong, somebody has
      // looked at it, and a schedule that came back already at four strikes
      // would disable itself again on the next hiccup.
      if (patch.enabled) update.consecutive_failures = 0;
    }

    // Any change to when it runs, or to whether it runs, moves the next fire.
    if (patch.cron !== undefined || patch.timezone !== undefined || patch.enabled !== undefined) {
      const enabled = patch.enabled ?? existing.enabled;
      const next = enabled ? computeNextRun({ ...merged, ...update }) : null;
      update.next_run_at = next ? next.toISOString() : null;
    }

    const [row] = await ctx.auth.db.from('schedules').eq('id', id).update(update, { returning: true });
    return sendJson(ctx.res, 200, { schedule: shape(row ?? { ...existing, ...update }) });
  }, { auth: 'write' });

  router.delete('/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const existing = await ctx.auth.db.from('schedules').select('id').eq('id', id).first();
    if (!existing) throw notFound('Schedule not found');

    await ctx.auth.db.from('schedules').eq('id', id).remove();
    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id,
      action: 'schedule.deleted', resource: 'schedule', resourceId: id, severity: 'info'
    });

    ctx.res.statusCode = 204;
    ctx.res.end();
  }, { auth: 'write' });

  /** Run it now, without waiting and without moving the schedule. */
  router.post('/:id/run', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const schedule = await ctx.auth.db.from('schedules').select('*').eq('id', id).first();
    if (!schedule) throw notFound('Schedule not found');

    const { runNow } = await import('./schedule.run.js');
    const task = await runNow(schedule, ctx.auth);
    return sendJson(ctx.res, 201, { task: { id: task.id, status: task.status }, streamUrl: `/api/tasks/${task.id}/stream` });
  }, { auth: 'write', rateLimit: 'heavy' });

  /** What an expression means, before it is stored. */
  router.post('/preview', async ctx => {
    const input = parse(t.object({
      cron: t.string({ required: true, max: 120 }),
      timezone: t.string({ max: 60, default: 'UTC' })
    }), await ctx.json());

    if (!isValidCron(input.cron)) throw badRequest(`"${input.cron}" is not a valid schedule.`);
    if (!validTimezone(input.timezone)) throw badRequest(`"${input.timezone}" is not a timezone this platform knows.`);

    // Five runs, so somebody can see it does what they meant before they set
    // it loose — a weekly schedule that turns out to be daily is expensive.
    const runs = [];
    let cursor = new Date();
    for (let index = 0; index < 5; index += 1) {
      const next = nextRun(input.cron, { from: cursor, timeZone: input.timezone });
      if (!next) break;
      runs.push(next.toISOString());
      cursor = next;
    }

    return sendJson(ctx.res, 200, {
      description: describeCron(input.cron, input.timezone),
      nextRuns: runs
    });
  }, { auth: true });

  return router;
}
