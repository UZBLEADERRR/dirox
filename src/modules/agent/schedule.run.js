/**
 * Running a schedule now, on purpose.
 *
 * Separate from the scheduler because it means something different: the
 * scheduler fires because a time arrived, and this fires because a person
 * pressed a button. The distinction matters in one place — the schedule's own
 * clock is not moved, so testing an automation at four in the afternoon does
 * not cancel its five o'clock run.
 */

import { enqueue, QUEUES } from '../../queue/queue.js';
import { badRequest } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

export async function runNow(schedule, auth) {
  if (!schedule?.objective) throw badRequest('This schedule has nothing to run.');

  const task = await auth.db.insert('tasks', {
    org_id: schedule.org_id,
    project_id: schedule.project_id,
    user_id: auth.user.id,
    schedule_id: schedule.id,
    title: `${schedule.name} (run now)`.slice(0, 200),
    objective: schedule.objective,
    mode: schedule.mode,
    status: 'queued',
    budget_micros: schedule.budget_micros
  }, { returning: true });

  await enqueue({
    kind: 'agent.run',
    queue: QUEUES.agent,
    priority: 20,
    payload: {
      taskId: task.id,
      trust: schedule.trust,
      autoTest: true,
      // Same as a scheduled run: this is the schedule's behaviour being
      // tested, and a plan gate would test something else.
      confirmPlan: false
    },
    orgId: schedule.org_id,
    projectId: schedule.project_id,
    taskId: task.id
  });

  logger.info('schedule run on demand', { scheduleId: schedule.id, taskId: task.id });
  return task;
}
