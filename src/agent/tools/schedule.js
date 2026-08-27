/**
 * Letting the agent set up work that runs later.
 *
 * "Check the dependencies every Monday" is a request the agent could satisfy
 * once and then never again. Turning it into a schedule is the difference
 * between doing a job and automating it, and the agent is the thing that
 * already understands what the job is.
 *
 * One line here is a security decision rather than a convenience: a schedule
 * the agent creates can never run at a higher trust than the run creating it.
 * Otherwise "set up a nightly cleanup" becomes a way to obtain permissions
 * nobody granted, from a model that read the request in a file.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { isValidCron, nextRun, describeCron } from '../../core/cron.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { TRUST } from '../permissions.js';

const MODES = ['ask', 'agent', 'autopilot', 'review', 'debug'];

/** Trust levels in order, so "no higher than" is a comparison. */
const LADDER = [TRUST.SAFE, TRUST.CONFIRM, TRUST.AUTONOMOUS];

function validTimezone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

export const scheduleTools = [
  {
    name: 'create_schedule',
    // Not a write to the repository, but it commits the user to future spend,
    // which is the kind of thing a person should see before it happens.
    risk: RISK.WRITE,
    description:
      'Set up work to run on a schedule, with nobody present — a weekly dependency check, a nightly report, a daily triage. ' +
      'Write the objective as though you were briefing someone who has not read this conversation: it will run on its own, without this context.',
    schema: t.object({
      name: t.string({ required: true, max: 120, description: 'What this automation is, in a few words' }),
      objective: t.string({ required: true, max: 4000, description: 'The complete instruction for the future run. It will not have this conversation.' }),
      cron: t.string({ required: true, max: 120, description: 'Five fields — minute hour day month weekday — or @daily, @weekly, @hourly' }),
      timezone: t.string({ max: 60, default: 'UTC', description: 'An IANA zone such as Asia/Tashkent' }),
      mode: t.enum(MODES, { default: 'agent' })
    }),
    async run({ name, objective, cron, timezone, mode }, ctx) {
      if (!hasServiceRole()) throw badRequest('Schedules are unavailable on this deployment.');
      if (!ctx.orgId || !ctx.userId) throw badRequest('A schedule belongs to a person and an organisation, and this run has neither.');

      if (!isValidCron(cron)) {
        throw badRequest(`"${cron}" is not a schedule. Use five fields — minute hour day month weekday — or a shorthand like @daily.`);
      }
      if (!validTimezone(timezone)) {
        throw badRequest(`"${timezone}" is not a timezone. Use an IANA name such as Asia/Tashkent or UTC.`);
      }

      const next = nextRun(cron, { timeZone: timezone });
      if (!next) throw badRequest(`"${cron}" will never occur — check the day and month.`);

      /*
         Never above the run that created it.

         Without this, "set up a nightly cleanup" is a way to get permissions
         nobody granted — from a model that may have read the instruction out
         of a file in the repository rather than from the person.
      */
      const current = LADDER.includes(ctx.trust) ? ctx.trust : TRUST.CONFIRM;

      const row = await serviceClient().insert('schedules', {
        org_id: ctx.orgId,
        user_id: ctx.userId,
        project_id: ctx.projectId ?? null,
        name,
        objective,
        mode,
        cron,
        timezone,
        trust: current,
        next_run_at: next.toISOString()
      }, { returning: true });

      return {
        output: [
          `Scheduled "${name}": ${describeCron(cron, timezone)}.`,
          `First run ${next.toISOString()}.`,
          `It will run at ${current} trust — the same as this run, and no higher.`,
          'The user can change or stop it in Settings.'
        ].join('\n'),
        metadata: { scheduleId: row.id, cron, timezone, nextRunAt: next.toISOString() }
      };
    }
  },

  {
    name: 'list_schedules',
    risk: RISK.SAFE,
    description: 'List the automations already set up, so you do not create a second one that does the same job.',
    schema: t.object({}),
    async run(_args, ctx) {
      if (!hasServiceRole() || !ctx.orgId) return { output: 'No schedules are available on this deployment.' };

      const rows = await serviceClient().from('schedules')
        .select('id,name,cron,timezone,enabled,mode,next_run_at,last_status')
        .eq('org_id', ctx.orgId)
        .limit(50)
        .all()
        .catch(() => []);

      if (!rows.length) return { output: 'Nothing is scheduled yet.' };

      const lines = rows.map(row => [
        `${row.enabled ? '●' : '○'} ${row.name} — ${describeCron(row.cron, row.timezone)}`,
        `   ${row.mode}${row.next_run_at ? `, next ${row.next_run_at}` : ', not scheduled'}${row.last_status ? `, last ${row.last_status}` : ''}`
      ].join('\n'));

      return { output: `${rows.length} schedule(s):\n${lines.join('\n')}`, metadata: { count: rows.length } };
    }
  }
];

export const SCHEDULE_TOOL_NAMES = new Set(scheduleTools.map(tool => tool.name));
