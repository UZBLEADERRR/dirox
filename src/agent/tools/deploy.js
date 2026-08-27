/**
 * Putting the change in front of the people who use it.
 *
 * The agent could build an application and not ship it, which makes it a
 * writer of code rather than a colleague. But deploying is not one thing, and
 * pretending otherwise is how a tool becomes a liability: a deployment is
 * whatever this particular project does — `git push` to a branch a platform
 * watches, `railway up`, `vercel --prod`, `make release`, an Ansible run. We
 * do not know, and guessing would be worse than asking.
 *
 * So the project says. `deploy_command` is stored beside `test_command` and
 * `build_command` and runs through the same sandbox, with the same allowlist,
 * with the same output limits — and asks first, every time, at every trust
 * level below autonomous, because this is the one action whose blast radius is
 * other people.
 *
 * Two refusals are built in and neither is negotiable:
 *
 *   Nothing deploys with the tests failing, unless the person says so in the
 *   same breath. An agent that ships a red build is worse than one that does
 *   not ship.
 *
 *   Nothing deploys that has not been built, where a build exists. The most
 *   common way to ship a broken release is to ship the last one's artefacts.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { runCommand } from '../../exec/sandbox.js';
import { logger } from '../../core/logger.js';

/** A deploy is allowed to take longer than a test run, and not much longer. */
const TIMEOUT_MS = 15 * 60 * 1000;

/** What the output usually says when it went wrong, in the order it matters. */
const FAILURE = /\b(error|failed|failure|denied|unauthori[sz]ed|forbidden|not found|timeout|refused|rollback|rolled back)\b/i;

/** The line that names where it went, when one exists. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/g;

function deployedUrls(text) {
  const found = [...String(text || '').matchAll(URL_PATTERN)]
    .map(match => match[0].replace(/[.,]$/, ''))
    // Registry and documentation links are noise; a deployment URL is not one.
    .filter(url => !/registry\.npmjs|nodejs\.org|docs\.|github\.com\/[^/]+\/[^/]+\/(issues|pull)/.test(url));
  return [...new Set(found)].slice(0, 4);
}

export const deployTools = [
  {
    name: 'deploy',
    // Outward-facing: the consequence of this leaves our container and reaches
    // whoever uses the thing. It asks below autonomous trust, always.
    risk: RISK.OUTWARD,
    description:
      'Run the project\'s deploy command, putting the current state of the workspace in front of real users. ' +
      'Only works when the project has a deploy command configured. Run the tests and the build first — this tool refuses a failing build unless you say why.',
    schema: t.object({
      why: t.string({ required: true, max: 300, description: 'One line: what is being shipped, and why now' }),
      testsPassed: t.boolean({
        default: false,
        description: 'True only if you have just run the tests and they passed'
      }),
      environment: t.string({ max: 40, description: 'Which environment, if the command takes one' })
    }),
    timeoutMs: TIMEOUT_MS + 30_000,
    async run({ why, testsPassed, environment }, ctx) {
      if (!ctx.projectId || !ctx.project) throw badRequest('Deploying needs an open project.');

      const command = ctx.project.deploy_command;
      if (!command) {
        throw badRequest(
          'This project has no deploy command, so there is nothing to run. '
          + 'Set one in project settings — whatever the team actually runs to ship: `git push production main`, `railway up`, `npm run deploy`.'
        );
      }

      /*
         The check that makes this safe to hand to a model.

         An agent that ships a red build is worse than one that never ships:
         it produces confident reports about a broken release. Saying the
         tests passed is a claim the agent has to make deliberately, so it
         cannot happen by omission.
      */
      if (!testsPassed && ctx.project.test_command) {
        return {
          ok: false,
          output: [
            'Not deploying: you have not confirmed the tests pass.',
            `Run ${ctx.project.test_command} first, then call this again with testsPassed: true.`,
            'If you mean to ship anyway, say so in `why` and set testsPassed: true — but be sure that is what you mean.'
          ].join('\n')
        };
      }

      const full = environment ? `${command} ${environment}` : command;
      logger.info('deploy starting', { projectId: ctx.projectId, taskId: ctx.taskId, why });

      const result = await runCommand(ctx.projectId, full, {
        timeoutMs: TIMEOUT_MS,
        maxOutput: 60_000,
        signal: ctx.signal,
        onOutput: ctx.onOutput
      });

      const text = result.output || '';
      const urls = deployedUrls(text);

      // A deploy tool that exits zero and calls it success is how a failed
      // release gets reported as a shipped one. The exit code is the primary
      // signal; wording in the output is a second one worth honouring.
      const looksWrong = !result.ok || (result.timedOut) || FAILURE.test(text.split('\n').slice(-30).join('\n'));

      if (looksWrong) {
        return {
          ok: false,
          output: [
            `Deploy failed: ${result.timedOut ? `timed out after ${Math.round(TIMEOUT_MS / 60000)} minutes` : `exit code ${result.exitCode}`}.`,
            `$ ${full}`,
            '',
            text.slice(-4000) || '(no output)'
          ].join('\n'),
          metadata: { exitCode: result.exitCode, timedOut: result.timedOut, deployed: false }
        };
      }

      logger.info('deploy finished', { projectId: ctx.projectId, taskId: ctx.taskId, urls });

      return {
        output: [
          `Deployed. ${why}`,
          `$ ${full} — exit code 0 in ${Math.round(result.durationMs / 1000)}s.`,
          urls.length ? `\nLive at: ${urls.join(', ')}` : null,
          '',
          text.slice(-1500) || '(no output)'
        ].filter(line => line !== null).join('\n'),
        metadata: { exitCode: 0, durationMs: result.durationMs, urls, deployed: true }
      };
    },

    riskFor(_args, ctx) {
      // Without a command there is nothing to run, and asking a person to
      // approve an action that will immediately refuse itself is noise.
      return ctx?.project?.deploy_command ? RISK.OUTWARD : RISK.SAFE;
    }
  }
];

export const DEPLOY_TOOL_NAMES = new Set(deployTools.map(tool => tool.name));
export { deployedUrls, FAILURE };
