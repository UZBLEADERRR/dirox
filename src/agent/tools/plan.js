/**
 * Letting a person watch the plan being worked through.
 *
 * A plan was already produced and shown once, as a paragraph, and then never
 * mentioned again. From the outside a long run became a stream of tool calls
 * with no sense of where it had got to — the one question anybody actually has
 * while waiting is "how far along is it", and nothing answered it.
 *
 * The step index cannot be inferred. Files changed do not map to plan steps,
 * and guessing produces a progress bar that lies, which is worse than none. So
 * the agent says. One cheap call, no output worth reading, and the timeline
 * and the plan card both move.
 *
 * It is deliberately not free: a tool call costs a little, and an agent that
 * narrates every keystroke would spend real money doing it. The description
 * says to call it when a step genuinely opens or closes, which is a handful of
 * times in a run.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';

export const STATUSES = ['in_progress', 'done', 'blocked'];

export const planTools = [
  {
    name: 'update_plan',
    risk: RISK.SAFE,
    description:
      'Mark a step of the plan as started, finished or blocked, so the person watching can see how far the work has got. ' +
      'Call it when a step genuinely opens or closes — not for every file you touch.',
    schema: t.object({
      step: t.integer({ required: true, min: 1, description: 'Which numbered step of the plan' }),
      status: t.enum(STATUSES, { required: true, description: 'in_progress when you start it, done when it is finished, blocked if it cannot be' }),
      note: t.string({ max: 200, description: 'One short line, only if the reason is not obvious' })
    }),
    async run({ step, status, note }, ctx) {
      if (!STATUSES.includes(status)) {
        throw badRequest(`Status must be one of: ${STATUSES.join(', ')}.`);
      }
      if (!ctx.updatePlanStep) {
        throw badRequest('There is no plan on this task to update.');
      }

      const result = ctx.updatePlanStep({ step, status, note });
      if (!result.ok) throw badRequest(result.reason);

      return {
        output: `Step ${step} is ${status}.${note ? ` ${note}` : ''} (${result.done}/${result.total} done)`,
        metadata: { step, status, done: result.done, total: result.total }
      };
    }
  }
];

export const PLAN_TOOL_NAMES = new Set(planTools.map(tool => tool.name));
