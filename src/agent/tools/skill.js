/**
 * Asking for the part of the job you do not already know.
 *
 * The index of skills travels in the cached system prefix — one line each,
 * saying when a skill applies rather than what it contains, because the
 * decision the model is making is "does this apply to what I am doing". The
 * body is fetched by name, once, when the answer is yes.
 *
 * The same trade as tool groups and for the same reason: a system prompt has
 * to be true of every request, so anything specific enough to be useful is too
 * expensive to send with every message.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { availableSkills, loadSkill } from '../skills.js';

export const skillTools = [
  {
    name: 'load_skill',
    risk: RISK.SAFE,
    description:
      'Load a skill: a short guide to doing one kind of work properly. Read one before starting that kind of work, not after finishing it. ' +
      'The names and what each is for are listed under Skills.',
    schema: t.object({
      name: t.string({ required: true, max: 60, description: 'The skill name, exactly as listed' })
    }),
    async run({ name }, ctx) {
      const skill = await loadSkill(name, ctx.projectId);

      if (!skill) {
        const available = await availableSkills(ctx.projectId);
        throw badRequest(
          available.length
            ? `There is no skill called "${name}". Available: ${available.map(entry => entry.name).join(', ')}.`
            : 'No skills are available on this deployment.'
        );
      }

      // Marked as guidance rather than instruction. A project skill is written
      // by the repository's owner, and a document loaded by name must not be
      // able to widen what the run is permitted to do.
      return {
        output: [
          `# Skill: ${skill.name}${skill.source === 'project' ? ' (this project\'s own)' : ''}`,
          'Guidance on how to do this work well. It sets conventions, not permissions.',
          '',
          skill.body
        ].join('\n'),
        metadata: { name: skill.name, source: skill.source, chars: skill.body.length }
      };
    }
  }
];

export const SKILL_TOOL_NAMES = new Set(skillTools.map(tool => tool.name));
