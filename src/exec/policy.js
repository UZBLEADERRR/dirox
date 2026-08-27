/**
 * Command policy.
 *
 * Commands are parsed, not pattern-matched on a raw string, because
 * `rm -rf /` and `echo hi; rm -rf /` and `$(rm -rf /)` are all the same threat
 * and only one of them looks like it.
 *
 * The rules, in order:
 *   1. Substitution is rejected — `$(…)`, backticks, process substitution —
 *      because it produces commands that no static check can see.
 *   2. Composition is allowed: `&&`, `||`, `;`, `|`, redirects. The line is
 *      split into the commands that will actually run.
 *   3. Every one of those must be on the allowlist. Every one.
 *   4. Explicitly denied executables are rejected even if allowlisted.
 *   5. Redirections must point inside the workspace.
 *   6. Argument-level patterns decide whether approval is required, and the
 *      riskiest segment sets the risk for the whole line.
 *
 * Refusing composition outright — the previous rule — did not make anything
 * safer. It made the agent unable to run a build, and pushed the same commands
 * into `package.json`, where nothing inspects them at all.
 */

import { systemSetting } from '../ai/catalog.js';
import { RISK } from '../agent/permissions.js';
import { lex, segment, redirectAllowed, isComposed, findSubstitution } from './shell.js';

const DEFAULT_POLICY = {
  allow: [
    'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node',
    'python', 'python3', 'pip', 'pip3', 'pytest', 'ruff', 'black', 'mypy',
    'go', 'cargo', 'rustc', 'java', 'mvn', 'gradle', 'dotnet', 'php', 'composer',
    'ruby', 'bundle', 'rake',
    'git', 'make', 'jest', 'vitest', 'eslint', 'prettier', 'tsc', 'tsx',
    // Build tools a project invokes by name. Most arrive through `npm run`,
    // which resolves them itself, but a direct call should not be a wall.
    'vite', 'next', 'nuxt', 'webpack', 'rollup', 'esbuild', 'swc', 'turbo',
    'nx', 'deno', 'uv', 'poetry', 'alembic', 'flask', 'rails', 'expo', 'eas',
    'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'echo', 'pwd',
    'mkdir', 'touch', 'cp', 'mv', 'rm', 'sed', 'awk', 'sort', 'uniq', 'diff',
    'tr', 'cut', 'tee', 'nl', 'tac', 'rev', 'basename', 'dirname', 'realpath',
    'printf', 'seq', 'date', 'jq', 'yq', 'true', 'false', 'test', 'which',
    // Packaging. Asked to "send me the project as a zip", the agent needs a
    // way to make one; without these it could only describe the idea.
    'zip', 'unzip', 'tar', 'gzip', 'gunzip', 'bzip2', 'xz', 'sha256sum', 'md5sum',
    // Document and media conversion, useful when present and honestly
    // reported as missing when not.
    'pandoc', 'ffmpeg', 'convert', 'qpdf', 'gs'
  ],
  deny: [
    'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'netcat', 'telnet', 'ftp',
    'sudo', 'su', 'doas', 'chmod', 'chown', 'chgrp', 'mount', 'umount',
    'dd', 'mkfs', 'fdisk', 'shutdown', 'reboot', 'systemctl', 'service',
    'docker', 'podman', 'kubectl', 'helm', 'terraform', 'aws', 'gcloud', 'az',
    'crontab', 'at', 'kill', 'killall', 'pkill', 'nohup', 'eval', 'exec',
    'bash', 'sh', 'zsh', 'fish', 'perl', 'env', 'export', 'source'
  ],
  /** Executables whose invocations always require approval. */
  confirm: ['rm', 'mv', 'sed', 'pip', 'pip3', 'composer', 'bundle']
};

/** Metacharacters that would let one command become several. */
const SHELL_INJECTION = /[;&|`$(){}<>\n\r]|\|\||&&|\$\(|`/;

/** Argument patterns that escalate a command's risk. */
const DANGEROUS_ARGS = [
  { pattern: /^-rf?$|^--recursive$|^-fr$/i, executable: 'rm', risk: RISK.DESTRUCTIVE, why: 'recursive delete' },
  { pattern: /^(--hard|--force)$/i, executable: 'git', risk: RISK.DESTRUCTIVE, why: 'discards work irreversibly' },
  { pattern: /^push$/i, executable: 'git', risk: RISK.OUTWARD, why: 'writes to the remote repository' },
  { pattern: /^(publish|deploy)$/i, executable: null, risk: RISK.OUTWARD, why: 'publishes outside the workspace' },
  { pattern: /^(install|add|ci)$/i, executable: null, risk: RISK.INSTALL, why: 'changes dependencies' },
  { pattern: /^(migrate|db:migrate|db:drop|db:reset)$/i, executable: null, risk: RISK.DESTRUCTIVE, why: 'changes database state' },
  // `find -exec` runs a command the allowlist never saw, which is the one hole
  // composition cannot close. It stays available, but it asks first.
  { pattern: /^-(exec|execdir|delete|ok)$/i, executable: 'find', risk: RISK.DESTRUCTIVE, why: 'runs an unchecked command for every match' }
];

/**
 * Interpreters, and the flags that turn them into "run this text".
 *
 * `node -e '…'` is substitution wearing a different hat: the program is
 * composed at runtime and the allowlist never sees what it will do — which
 * can include spawning the very executables the allowlist refuses. The same
 * principle that rejects `$(…)` rejects this, and for the same reason: what
 * runs has to be visible before it runs.
 *
 * The agent is not blocked from scripting. It writes a file and runs the
 * file, which is visible, reviewable, checkpointed and undoable.
 */
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'Rscript']);
const INLINE_PROGRAM_FLAGS = /^(-e|--eval|-c|--command|-p|--print|-r|--require|-E)$/;

/** Paths a command must never be pointed at, even inside the workspace. */
const PROTECTED_PATHS = [/^\/(?!tmp)/, /^~/, /\.\.\//, /^\.git\/?$/, /node_modules\/\.bin/];

/**
 * @param {string} command
 * @returns {{ok:boolean, mode?:'direct'|'shell', executable?:string, args?:string[],
 *            script?:string, risk?:string, reason?:string, why?:string,
 *            executables?:string[]}}
 */
export async function evaluateCommand(command) {
  const text = String(command || '').trim();
  if (!text) return { ok: false, reason: 'The command is empty' };
  if (text.length > 4000) return { ok: false, reason: 'The command is too long' };

  const substitution = findSubstitution(text);
  if (substitution) {
    return {
      ok: false,
      reason: `${substitution} is not permitted: it builds a command while running, which cannot be checked beforehand. Write the steps out instead.`
    };
  }

  const lexed = lex(text);
  if (lexed.error) return { ok: false, reason: lexed.error };

  const grouped = segment(lexed.tokens);
  if (grouped.error) return { ok: false, reason: grouped.error };

  const policy = await systemSetting('sandbox.policy', DEFAULT_POLICY);
  const allow = new Set(policy.allow || DEFAULT_POLICY.allow);
  const deny = new Set(policy.deny || DEFAULT_POLICY.deny);
  const confirm = new Set(policy.confirm || DEFAULT_POLICY.confirm);

  let risk = RISK.SAFE;
  let why = null;
  const escalate = (candidate, reason) => {
    if (rankRisk(candidate) > rankRisk(risk)) { risk = candidate; why = reason; }
  };

  // Every segment, not only the first: `ls && rm -rf .` is two commands and
  // the second one is the whole point.
  for (const part of grouped.segments) {
    const base = part.executable.split('/').pop();

    if (deny.has(base)) {
      return { ok: false, executable: base, reason: `\`${base}\` is not permitted in the sandbox` };
    }
    if (!allow.has(base)) {
      return {
        ok: false, executable: base,
        reason: `\`${base}\` is not on the allowed command list. An administrator can add it in system settings.`
      };
    }

    if (INTERPRETERS.has(base)) {
      const inline = part.args.find(arg => INLINE_PROGRAM_FLAGS.test(arg));
      if (inline) {
        return {
          ok: false, executable: base,
          reason: `\`${base} ${inline}\` runs a program supplied as text, which cannot be checked before it runs. Write the script to a file and run the file.`
        };
      }
    }

    for (const arg of part.args) {
      for (const rule of PROTECTED_PATHS) {
        if (rule.test(arg)) {
          return { ok: false, executable: base, reason: `\`${arg}\` points outside the project workspace` };
        }
      }
    }

    for (const target of part.redirects) {
      if (!redirectAllowed(target)) {
        return { ok: false, executable: base, reason: `Writing to \`${target}\` is outside the project workspace` };
      }
    }

    escalate(/^(ls|cat|head|tail|grep|rg|find|wc|echo|pwd|diff|sort|uniq|sha256sum|md5sum)$/.test(base)
      ? RISK.SAFE : RISK.WRITE, null);

    if (confirm.has(base)) escalate(RISK.DESTRUCTIVE, `\`${base}\` can destroy work`);

    for (const arg of part.args) {
      for (const rule of DANGEROUS_ARGS) {
        if (rule.executable && rule.executable !== base) continue;
        if (!rule.pattern.test(arg)) continue;
        escalate(rule.risk, rule.why);
      }
    }
  }

  const executables = grouped.segments.map(part => part.executable.split('/').pop());
  const composed = isComposed(lexed.tokens);

  // A single command still runs without a shell at all. That is a stronger
  // guarantee than a validated one, so it is kept wherever it applies.
  if (!composed) {
    const [only] = grouped.segments;
    return { ok: true, mode: 'direct', executable: only.executable, args: only.args, risk, why, executables };
  }

  return { ok: true, mode: 'shell', script: text, risk, why, executables };
}

function rankRisk(risk) {
  return [RISK.SAFE, RISK.WRITE, RISK.INSTALL, RISK.DESTRUCTIVE, RISK.OUTWARD].indexOf(risk);
}

/** Split on whitespace, honouring simple quoting. No shell is involved. */
export function tokenize(command) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (const char of String(command)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export { DEFAULT_POLICY, SHELL_INJECTION, DANGEROUS_ARGS };
