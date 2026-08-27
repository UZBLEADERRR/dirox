/**
 * Handing a piece of the work to someone else.
 *
 * The tool is small because the decision is the hard part, not the mechanism.
 * What it has to get right is stopping the model from delegating badly, and
 * there are exactly two ways to delegate badly:
 *
 *   Too small. "Read src/auth.js" delegated costs a model call, a route, a
 *   context assembly and a report, to do what one `read_file` does. The
 *   description says so plainly, because a model that has been given a
 *   delegation tool will otherwise use it for everything.
 *
 *   Too vague. "Sort out the auth" gives the child no way to know when it is
 *   finished, so it works until its step limit and reports something
 *   approximate. The schema asks for a job with an end.
 *
 * A delegated job returns one paragraph. Everything the child read, ran and
 * abandoned stays in the child's conversation, which is discarded — which is
 * the whole reason to delegate rather than to keep reading.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { ROLE_NAMES, ROLES, runSubAgent, delegationSettings } from '../subagent.js';

const ROLE_LINES = ROLE_NAMES.map(name => `  ${name} — ${ROLES[name].summary}`).join('\n');

export const delegateTools = [
  {
    name: 'delegate',
    // The risk is the child's, resolved per call: an explorer cannot write, so
    // treating it as a write would put an approval gate in front of a question.
    risk: RISK.WRITE,
    description:
      'Hand one self-contained piece of work to a sub-agent and get back a short report. ' +
      'The sub-agent has its own conversation, so what it reads and runs does not stay in yours — ' +
      'use this when a piece of the task would otherwise fill your context with detail you will not need again.\n' +
      `Roles:\n${ROLE_LINES}\n` +
      'Do not delegate something you can do in one tool call, and do not delegate a job without a clear finish.',
    schema: t.object({
      role: t.string({ required: true, max: 20, description: ROLE_NAMES.join(' | ') }),
      objective: t.string({ required: true, max: 2000, description: 'One self-contained job, specific enough that the sub-agent knows when it is done' }),
      brief: t.string({ max: 1200, description: 'Only what the sub-agent needs that it cannot find for itself — decisions already made, paths already known' })
    }),
    async run({ role, objective, brief }, ctx) {
      if (!ROLES[role]) {
        throw badRequest(`There is no "${role}" sub-agent. Choose one of: ${ROLE_NAMES.join(', ')}.`);
      }
      if (!ctx.delegate) {
        throw badRequest('This run cannot delegate. Do the work directly.');
      }

      const settings = await delegationSettings();
      if (settings.enabled === false) {
        throw badRequest('Delegation is switched off for this deployment. Do the work directly.');
      }

      const spawned = ctx.childCount?.() ?? 0;
      if (spawned >= (Number(settings.max_children) || 6)) {
        throw badRequest(
          `This task has already delegated ${spawned} jobs, which is the limit. ` +
          'Finish the work directly rather than splitting it further.'
        );
      }

      return ctx.delegate({ role, objective, brief });
    },
    riskFor({ role }) {
      // An explorer and a reviewer cannot change anything, and asking a person
      // to approve a question is how an approval prompt stops meaning anything.
      return ROLES[role]?.toolset === 'read' ? RISK.SAFE : RISK.WRITE;
    }
  }
];

export { runSubAgent, ROLE_NAMES };
