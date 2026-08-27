/**
 * The tool that fetches other tools.
 *
 * It does not execute anything: it records what the run should carry from the
 * next call onwards. The orchestrator reads that and widens the tool list it
 * sends, which is the only place that can — a tool cannot change the request
 * it was called in.
 *
 * The result names the tools that just became available, because a model told
 * only "loaded" would have to guess at the names.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { TOOL_GROUPS, GROUP_NAMES, groupCatalogue, toolNamesForGroups } from './groups.js';

export const loaderTools = [
  {
    name: 'load_tools',
    risk: RISK.SAFE,
    description:
      'Load a group of tools you do not currently have. Everything for reading, editing, searching and running ' +
      'commands is already available; call this only when a task needs something else.\n\n' +
      `Groups:\n${groupCatalogue()}`,
    schema: t.object({
      groups: t.array(t.enum(GROUP_NAMES), { required: true, max: 4, description: 'Group names to load' })
    }),
    async run({ groups }, ctx) {
      const wanted = [...new Set(groups)].filter(name => TOOL_GROUPS[name]);
      if (!wanted.length) {
        return { ok: false, output: `No such group. Available: ${GROUP_NAMES.join(', ')}.` };
      }

      const already = wanted.filter(name => ctx.loadedGroups?.has(name));
      const fresh = wanted.filter(name => !ctx.loadedGroups?.has(name));

      // Recorded, not applied: the tool list for the call already in flight is
      // fixed. The next one carries these.
      for (const name of fresh) ctx.loadGroup?.(name);

      const names = toolNamesForGroups(fresh);
      const unavailable = fresh.filter(name => !ctx.availableGroups?.has(name));

      if (unavailable.length) {
        return {
          ok: false,
          output: `${unavailable.join(', ')} ${unavailable.length === 1 ? 'is' : 'are'} not available on this task — ` +
            'the account it needs is not connected, or the project has no such capability.'
        };
      }

      return {
        output: [
          fresh.length ? `Loaded ${fresh.join(', ')}. Available from now on: ${names.join(', ')}.` : null,
          already.length ? `${already.join(', ')} was already loaded.` : null
        ].filter(Boolean).join('\n'),
        metadata: { loaded: fresh, tools: names }
      };
    }
  }
];
