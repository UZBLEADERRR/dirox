/**
 * Terminal, test, build and dependency tools.
 *
 * Every one of these goes through the sandbox, which means every one is
 * allowlist-checked per segment. Composition is allowed because a build is
 * composition; substitution is not, because it hides what will run. The test
 * and build tools use the project's own configured commands rather than
 * guessing.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { runCommand } from '../../exec/sandbox.js';

/** Summarise a test run so the model gets the verdict, not 2,000 log lines. */
function summariseTestOutput(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  const patterns = [
    /Tests?:\s+(\d+)\s+failed[,\s]+(\d+)\s+passed/i,
    /(\d+)\s+passed[,\s]+(\d+)\s+failed/i,
    /(\d+)\s+passing[\s\S]{0,40}?(\d+)\s+failing/i,
    /(\d+)\s+passed[,\s]+(\d+)\s+skipped/i,
    /ok\s+(\d+)[\s\S]*?not ok\s+(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return result.ok ? 'All checks passed' : `Exited with code ${result.exitCode}`;
}

/** Pull out the lines that actually explain a failure. */
function extractFailures(output, limit = 40) {
  const lines = String(output).split('\n');
  const interesting = lines.filter(line =>
    /\b(fail|failed|error|exception|assert|expected|received|traceback|panic|cannot find|is not defined|undefined)\b/i.test(line)
  );
  if (!interesting.length) return lines.slice(-limit).join('\n');
  return interesting.slice(0, limit).join('\n');
}

export const terminalTools = [
  {
    name: 'execute_command',
    risk: RISK.WRITE,
    description:
      'Run a command in the project workspace. Chaining, pipes and redirection work: ' +
      '`npm run build && npm test`, `npm test 2>&1 | tail -40`, `ls x 2>/dev/null || echo missing`. ' +
      'Substitution does not: no $(...), no backticks, and no inline programs such as `node -e`. ' +
      'Every executable in the line must be allowlisted and nothing may write outside the workspace. ' +
      'To script something, write the script to a file and run the file.',
    schema: t.object({
      command: t.string({ required: true, max: 2000, description: 'e.g. "npm run build && npm test"' }),
      cwd: t.string({ max: 300, description: 'Optional subdirectory to run in' }),
      timeoutSeconds: t.integer({ min: 5, max: 600, default: 120 })
    }),
    async run({ command, cwd, timeoutSeconds }, ctx) {
      const result = await runCommand(ctx.projectId, command, {
        cwd,
        timeoutMs: timeoutSeconds * 1000,
        signal: ctx.signal,
        onOutput: ctx.onOutput
      });

      const verdict = result.timedOut
        ? `Timed out after ${timeoutSeconds}s`
        : result.ok ? 'Exit code 0' : `Exit code ${result.exitCode}`;

      return {
        ok: result.ok,
        output: `$ ${result.command}\n${verdict}\n\n${result.output || '(no output)'}`,
        metadata: {
          exitCode: result.exitCode, durationMs: result.durationMs,
          timedOut: result.timedOut, truncated: result.truncated
        }
      };
    },
    /** The risk depends on the command, so it is computed per call. */
    async riskFor({ command }) {
      const { inspectCommand } = await import('../../exec/sandbox.js');
      const evaluation = await inspectCommand(command);
      return evaluation.ok ? evaluation.risk : RISK.DESTRUCTIVE;
    }
  },

  {
    name: 'run_tests',
    risk: RISK.WRITE,
    description: 'Run the project test suite and report the result. Uses the project\'s configured test command.',
    schema: t.object({
      pattern: t.string({ max: 200, description: 'Optional test file or name filter' }),
      timeoutSeconds: t.integer({ min: 10, max: 900, default: 300 })
    }),
    async run({ pattern, timeoutSeconds }, ctx) {
      const base = ctx.project?.test_command;
      if (!base) {
        throw badRequest(
          'This project has no test command configured. Set one in project settings, or run the command directly with execute_command.'
        );
      }

      const command = pattern ? `${base} ${pattern}` : base;
      const result = await runCommand(ctx.projectId, command, {
        timeoutMs: timeoutSeconds * 1000,
        maxOutput: 60_000,
        signal: ctx.signal,
        onOutput: ctx.onOutput
      });

      const summary = summariseTestOutput(result);
      const body = result.ok ? '' : `\n\n${extractFailures(result.output)}`;

      return {
        ok: result.ok,
        output: `$ ${command}\n${summary}${body}`,
        metadata: {
          passed: result.ok, exitCode: result.exitCode,
          durationMs: result.durationMs, summary, timedOut: result.timedOut
        }
      };
    }
  },

  {
    name: 'run_build',
    risk: RISK.WRITE,
    description: 'Build the project and report whether it compiled. Uses the project\'s configured build command.',
    schema: t.object({ timeoutSeconds: t.integer({ min: 10, max: 900, default: 420 }) }),
    async run({ timeoutSeconds }, ctx) {
      const command = ctx.project?.build_command;
      if (!command) throw badRequest('This project has no build command configured.');

      const result = await runCommand(ctx.projectId, command, {
        timeoutMs: timeoutSeconds * 1000,
        maxOutput: 40_000,
        signal: ctx.signal,
        onOutput: ctx.onOutput
      });

      return {
        ok: result.ok,
        output: result.ok
          ? `$ ${command}\nBuild succeeded in ${Math.round(result.durationMs / 1000)}s`
          : `$ ${command}\nBuild failed (exit ${result.exitCode})\n\n${extractFailures(result.output, 50)}`,
        metadata: { succeeded: result.ok, exitCode: result.exitCode, durationMs: result.durationMs }
      };
    }
  },

  {
    name: 'run_linter',
    risk: RISK.WRITE,
    description: 'Run the project linter or type checker to catch problems before running tests.',
    schema: t.object({
      command: t.string({ max: 200, description: 'Optional explicit lint command; otherwise inferred from the project' })
    }),
    async run({ command }, ctx) {
      const inferred = command || inferLintCommand(ctx.project);
      if (!inferred) throw badRequest('No linter is configured for this project. Pass an explicit command.');

      const result = await runCommand(ctx.projectId, inferred, {
        timeoutMs: 180_000, maxOutput: 30_000, signal: ctx.signal
      });

      return {
        ok: result.ok,
        output: `$ ${inferred}\n${result.ok ? 'No problems reported' : extractFailures(result.output, 40)}`,
        metadata: { clean: result.ok, exitCode: result.exitCode }
      };
    }
  },

  {
    name: 'install_dependency',
    risk: RISK.INSTALL,
    description: 'Add a dependency to the project. Requires approval unless the organization trusts installs.',
    schema: t.object({
      packages: t.array(t.string({ max: 120 }), { required: true, min: 1, max: 10 }),
      dev: t.boolean({ default: false })
    }),
    async run({ packages, dev }, ctx) {
      // Package names are validated so an argument cannot become a flag.
      for (const name of packages) {
        if (!/^(@[\w.-]+\/)?[\w.-]+(@[\w.^~>=<*-]+)?$/.test(name)) {
          throw badRequest(`"${name}" is not a valid package name`);
        }
      }

      const manager = ctx.project?.package_manager || 'npm';
      const command = buildInstallCommand(manager, packages, dev);
      if (!command) throw badRequest(`Automatic installs are not supported for ${manager}. Use execute_command.`);

      const result = await runCommand(ctx.projectId, command, {
        timeoutMs: 300_000, maxOutput: 20_000, signal: ctx.signal, onOutput: ctx.onOutput
      });

      return {
        ok: result.ok,
        output: result.ok
          ? `Installed ${packages.join(', ')}`
          : `Install failed (exit ${result.exitCode})\n\n${extractFailures(result.output, 25)}`,
        metadata: { packages, manager, exitCode: result.exitCode }
      };
    }
  }
];

function inferLintCommand(project) {
  const manager = project?.package_manager;
  if (!manager || !['npm', 'pnpm', 'yarn', 'bun'].includes(manager)) {
    if (project?.language === 'Python') return 'ruff check .';
    if (project?.language === 'Go') return 'go vet ./...';
    if (project?.language === 'Rust') return 'cargo clippy';
    return null;
  }
  return manager === 'npm' ? 'npm run lint' : `${manager} run lint`;
}

function buildInstallCommand(manager, packages, dev) {
  const list = packages.join(' ');
  switch (manager) {
    case 'npm': return `npm install ${dev ? '--save-dev ' : ''}${list}`;
    case 'pnpm': return `pnpm add ${dev ? '-D ' : ''}${list}`;
    case 'yarn': return `yarn add ${dev ? '--dev ' : ''}${list}`;
    case 'bun': return `bun add ${dev ? '-d ' : ''}${list}`;
    case 'pip': case 'pip3': return `pip install ${list}`;
    case 'cargo': return `cargo add ${list}`;
    case 'composer': return `composer require ${dev ? '--dev ' : ''}${list}`;
    default: return null;
  }
}

export { summariseTestOutput, extractFailures, inferLintCommand };
