import { createTask, setTaskStatus, addSubtask, updateSubtask, recordMetrics } from '../state/task.js';
import { routeModel } from './router.js';
import { planTask } from './planner.js';
import { executeSubtask } from './executor.js';
import { verifyResult, RETRY_LIMIT } from './verifier.js';

const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

/** Planner -> router -> executor -> verifier loop. Returns the final task state. */
export async function runAgentLoop(input = {}, options = {}) {
  let task = createTask(input);
  task = setTaskStatus(task, 'planning');
  const route = routeModel({ ...input, task }, { ...process.env, ...(options.models || {}) });
  const plan = planTask(task, options.planResponse);
  for (const title of plan.subtasks) task = addSubtask(task, title);
  task = setTaskStatus(task, 'running');
  task = recordMetrics(task, { attempts: 1, increment: true });

  for (const item of task.subtasks) {
    let retries = 0;
    let verified = false;
    while (!verified) {
      task = updateSubtask(task, item.id, { status: 'running', error: null });
      try {
        const execution = await (options.execute || executeSubtask)(item, { ...options.context, successCriteria: plan.successCriteria }, { ...options, model: route.model, retries });
        const evidence = options.evidenceFor ? await options.evidenceFor(execution, item, task) : (execution.evidence || {});
        const check = verifyResult(execution, evidence, { retries });
        task = updateSubtask(task, item.id, { status: check.passed ? 'completed' : 'failed', result: execution.result, error: check.passed ? null : check.reason });
        if (check.passed) { verified = true; break; }
        retries += 1;
        task = recordMetrics(task, { retries: 1, attempts: 1, increment: true });
        // Dalil umuman berilmagan bo‘lsa, qayta so‘rov yuborib tokenni kuydirmaymiz.
        if (!Object.keys(check.evidence || {}).some(key => check.evidence[key])) {
          task = updateSubtask(task, item.id, { status: 'failed', error: 'Verification evidence is missing' });
          task = setTaskStatus(task, 'failed', 'Verification evidence is missing');
          return { task: copy(task), plan, route };
        }
        if (!check.retry || retries > RETRY_LIMIT) {
          task = updateSubtask(task, item.id, { status: 'failed', error: check.reason });
          task = setTaskStatus(task, 'failed', check.reason);
          return { task: copy(task), plan, route };
        }
      } catch (error) {
        retries += 1;
        task = recordMetrics(task, { retries: 1, attempts: 1, increment: true });
        if (retries > RETRY_LIMIT) {
          task = updateSubtask(task, item.id, { status: 'failed', error: error.message });
          task = setTaskStatus(task, 'failed', error.message);
          return { task: copy(task), plan, route };
        }
      }
    }
  }
  task = setTaskStatus(task, 'verifying');
  task = setTaskStatus(task, 'completed');
  return { task: copy(task), plan, route };
}

export { RETRY_LIMIT };
export default runAgentLoop;
