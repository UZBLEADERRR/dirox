/**
 * Work that starts without anybody typing.
 *
 * The queue already ran background jobs; nothing put work into it on a clock.
 * That is the difference between a tool somebody uses and an automation that
 * runs — "check the dependencies every Monday", "triage new issues each
 * morning", "rebuild the changelog after every release".
 *
 * The loop is deliberately dull:
 *
 *   every minute, ask for schedules whose `next_run_at` has passed;
 *   for each, create a task, queue it, and write down when it next fires.
 *
 * Everything interesting is in the failure cases, because a scheduler runs
 * unattended and the ways it goes wrong are the ways it costs money:
 *
 *   A tick that is late must not fire the missed runs one after another.
 *   A container that restarts mid-tick must not run the same schedule twice.
 *   A schedule that fails forever must stop, rather than failing hourly until
 *   somebody notices the bill.
 */

import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { enqueue, QUEUES } from './queue.js';
import { nextRun, parseCron } from '../core/cron.js';
import { featureEnabled } from '../ai/catalog.js';
import { logger } from '../core/logger.js';

/** How often the scheduler looks. A minute is the finest a cron can express. */
const TICK_MS = 60_000;

/** How many schedules one tick will start. */
const BATCH = 25;

/**
 * After this many consecutive failures a schedule turns itself off.
 *
 * An automation that fails every hour forever costs real money and teaches
 * its owner to ignore its notifications, which is worse than it being off.
 */
const FAILURE_LIMIT = 5;

let timer = null;
let ticking = false;

/** When this schedule fires next, from now. */
export function computeNextRun(schedule, from = new Date()) {
  try {
    return nextRun(schedule.cron, { from, timeZone: schedule.timezone || 'UTC' });
  } catch (error) {
    logger.warn('schedule has an invalid expression', { id: schedule.id, cron: schedule.cron, reason: error?.message });
    return null;
  }
}

/**
 * Start one schedule.
 *
 * The row is claimed before the task is created: `next_run_at` moves forward
 * first, so a second worker — or the same worker after a restart — finds
 * nothing due and does not run the same schedule twice. Losing a run to a
 * crash between the claim and the queue is the better failure of the two.
 */
async function fire(client, schedule, now) {
  // One instant for the whole tick. Reading the clock again per schedule
  // means schedules in the same batch are projected from different times,
  // which is invisible in production and impossible to test.
  const following = computeNextRun(schedule, now);

  const claimed = await client.from('schedules')
    .eq('id', schedule.id)
    // Only if nobody else has moved it. Without this a second worker on the
    // same tick fires the same schedule.
    .eq('next_run_at', schedule.next_run_at)
    .update({
      next_run_at: following ? following.toISOString() : null,
      last_run_at: now.toISOString(),
      run_count: (schedule.run_count ?? 0) + 1,
      // An expression that will never fire again is not a schedule any more.
      enabled: following ? schedule.enabled : false
    }, { returning: true });

  if (!claimed?.length) return null;

  const task = await client.insert('tasks', {
    org_id: schedule.org_id,
    project_id: schedule.project_id,
    user_id: schedule.user_id,
    schedule_id: schedule.id,
    title: schedule.name.slice(0, 200),
    objective: schedule.objective,
    mode: schedule.mode,
    status: 'queued',
    budget_micros: schedule.budget_micros
  }, { returning: true });

  await enqueue({
    kind: 'agent.run',
    queue: QUEUES.agent,
    priority: 40,
    payload: {
      taskId: task.id,
      trust: schedule.trust,
      autoTest: true,
      // Nobody is present to approve a plan, so there is no point stopping to
      // ask for one. The trust level, chosen by a person when the schedule was
      // made, is what bounds this run instead.
      confirmPlan: false
    },
    orgId: schedule.org_id,
    projectId: schedule.project_id,
    taskId: task.id
  });

  logger.info('schedule fired', { scheduleId: schedule.id, taskId: task.id, next: following?.toISOString() ?? null });
  return task.id;
}

/**
 * One pass over what is due.
 *
 * @returns {Promise<{fired:number, checked:number}>}
 */
export async function tick(now = new Date()) {
  if (!hasServiceRole()) return { fired: 0, checked: 0 };
  if (!await featureEnabled('schedules').catch(() => true)) return { fired: 0, checked: 0 };

  const client = serviceClient();

  /*
     Due, not overdue-by-how-much.

     A tick that is late — a deploy, a restart, a slow worker — finds several
     schedules past their time. Each fires once and its next run is computed
     from now, so an hourly schedule that was down for a day runs once on
     recovery rather than twenty-four times in a row.
  */
  const due = await client.from('schedules')
    .select('*')
    .eq('enabled', true)
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(BATCH)
    .all()
    .catch(error => {
      logger.warn('could not read due schedules', { reason: error?.message });
      return [];
    });

  let fired = 0;
  for (const schedule of due) {
    try {
      if (await fire(client, schedule, now)) fired += 1;
    } catch (error) {
      logger.error('a schedule could not be started', { id: schedule.id, reason: error?.message });
      await recordFailure(client, schedule, error?.message).catch(() => {});
    }
  }

  return { fired, checked: due.length };
}

/** A schedule that keeps failing stops. */
export async function recordFailure(client, schedule, reason) {
  const failures = (schedule.consecutive_failures ?? 0) + 1;
  await client.from('schedules').eq('id', schedule.id).update({
    consecutive_failures: failures,
    last_status: String(reason || 'failed').slice(0, 200),
    enabled: failures < FAILURE_LIMIT
  });

  if (failures >= FAILURE_LIMIT) {
    logger.warn('schedule disabled after repeated failures', { id: schedule.id, failures });
  }
}

/** A run that worked clears the count. */
export async function recordSuccess(scheduleId, taskId, status) {
  if (!scheduleId || !hasServiceRole()) return;
  const patch = { last_status: status, last_task_id: taskId };
  // A run that worked clears the count; one that did not leaves it alone, so
  // the failure path is the only thing that increments it.
  if (status === 'completed') patch.consecutive_failures = 0;

  await serviceClient().from('schedules').eq('id', scheduleId).update(patch).catch(() => {});
}

export function startScheduler() {
  if (timer || !hasServiceRole()) {
    if (!hasServiceRole()) logger.warn('scheduler not started — SUPABASE_SERVICE_ROLE_KEY is required');
    return;
  }

  timer = setInterval(async () => {
    // A tick that overruns must not start a second one alongside itself.
    if (ticking) return;
    ticking = true;
    try {
      const result = await tick();
      if (result.fired) logger.info('scheduler tick', result);
    } catch (error) {
      logger.error('scheduler tick failed', { reason: error?.message });
    } finally {
      ticking = false;
    }
  }, TICK_MS);
  timer.unref?.();

  logger.info('scheduler started', { everyMs: TICK_MS });
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { TICK_MS, BATCH, FAILURE_LIMIT, parseCron };
