/**
 * Sandboxed command execution.
 *
 * `spawn` is called with an explicit argument array and `shell: false`, so the
 * operating system never interprets the command string. Combined with the
 * policy check in policy.js, there is no path from a model-produced string to
 * a shell.
 *
 * Limits enforced here: wall-clock timeout, captured output size, environment
 * scrubbing, working directory confinement and process-group termination.
 */

import { spawn } from 'node:child_process';
import { config } from '../config/env.js';
import { forbidden, timedOut } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { workspacePath, ensureWorkspace, resolveInside } from './workspace.js';
import { evaluateCommand } from './policy.js';
import { runtimeStats } from '../modules/observability/audit.js';

/**
 * The environment a command sees.
 *
 * An allowlist, not a denylist: the process environment holds provider keys,
 * the Supabase service role key and the encryption key, and none of them may
 * leak into a subprocess that a model asked for.
 */
function sandboxEnv(workspace, extra = {}) {
  const passthrough = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TERM'];
  const env = {
    PWD: workspace,
    HOME: workspace,
    TMPDIR: `${workspace}/.tmp`,
    CI: '1',
    NODE_ENV: 'development',
    NO_COLOR: '1',
    npm_config_yes: 'true',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
  };
  for (const key of passthrough) if (process.env[key]) env[key] = process.env[key];

  // Only explicitly-passed extras, and never anything credential-shaped.
  for (const [key, value] of Object.entries(extra)) {
    if (/(?:key|secret|token|password|credential)/i.test(key)) continue;
    env[key] = String(value);
  }
  return env;
}

/**
 * @param {string} projectId
 * @param {string} command
 * @param {{cwd?:string, timeoutMs?:number, maxOutput?:number, signal?:AbortSignal, env?:object, onOutput?:Function}} options
 * @returns {Promise<{ok:boolean, exitCode:number|null, stdout:string, stderr:string, output:string,
 *                    truncated:boolean, durationMs:number, timedOut:boolean, command:string}>}
 */
export async function runCommand(projectId, command, options = {}) {
  if (!config.sandbox.enabled) throw forbidden('Command execution is disabled on this deployment');

  const evaluation = await evaluateCommand(command);
  if (!evaluation.ok) throw forbidden(evaluation.reason);

  const workspace = await ensureWorkspace(projectId);
  const cwd = options.cwd ? await resolveInside(projectId, options.cwd) : workspace;

  const timeoutMs = Math.min(options.timeoutMs || config.sandbox.timeoutMs, 600_000);
  const maxOutput = Math.min(options.maxOutput || config.sandbox.maxOutput, 200_000);

  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let truncated = false;
  let killedByTimeout = false;

  const child = spawn(evaluation.executable, evaluation.args, {
    cwd,
    env: sandboxEnv(workspace, options.env),
    shell: false,             // the critical flag: no shell interpretation, ever
    detached: true,           // own process group, so a whole tree can be killed
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const capture = (stream, target) => {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      if (truncated) return;
      const room = maxOutput - (stdout.length + stderr.length);
      if (room <= 0) {
        truncated = true;
        terminate('output limit');
        return;
      }
      const text = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (target === 'stdout') stdout += text; else stderr += text;
      options.onOutput?.({ stream: target, text });
    });
  };
  capture(child.stdout, 'stdout');
  capture(child.stderr, 'stderr');

  function terminate(reason) {
    try {
      // Negative pid signals the whole process group.
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 3000).unref?.();
    } catch { /* the process already exited */ }
    logger.debug('sandbox process terminated', { reason, command: evaluation.executable });
  }

  const timer = setTimeout(() => { killedByTimeout = true; terminate('timeout'); }, timeoutMs);
  const onAbort = () => terminate('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const exitCode = await new Promise(resolve => {
    child.on('error', error => {
      stderr += `\n${error.message}`;
      resolve(null);
    });
    child.on('close', code => resolve(code));
  });

  clearTimeout(timer);
  options.signal?.removeEventListener('abort', onAbort);

  const durationMs = Date.now() - started;
  const ok = exitCode === 0 && !killedByTimeout;
  runtimeStats.tool(!ok);

  if (killedByTimeout) {
    logger.warn('sandbox command timed out', { command: evaluation.executable, timeoutMs, projectId });
  }

  const output = [stdout, stderr].filter(Boolean).join('\n').trim();

  return {
    ok,
    exitCode,
    stdout,
    stderr,
    output: truncated ? `${output}\n\n[output truncated at ${maxOutput} characters]` : output,
    truncated,
    timedOut: killedByTimeout,
    durationMs,
    command: `${evaluation.executable} ${evaluation.args.join(' ')}`.trim(),
    risk: evaluation.risk
  };
}

/** Read the risk of a command without running it, for approval prompts. */
export async function inspectCommand(command) {
  return evaluateCommand(command);
}

export { sandboxEnv };
