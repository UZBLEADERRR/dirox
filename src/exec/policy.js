/**
 * Command policy.
 *
 * Commands are parsed, not pattern-matched on a raw string, because
 * `rm -rf /` and `echo hi; rm -rf /` and `$(rm -rf /)` are all the same threat
 * and only one of them looks like it.
 *
 * The rules, in order:
 *   1. Shell metacharacters that chain or substitute commands are rejected.
 *   2. The executable must be on the allowlist.
 *   3. Explicitly denied executables are rejected even if allowlisted.
 *   4. Argument-level patterns decide whether approval is required.
 */

import { systemSetting } from '../ai/catalog.js';
import { RISK } from '../agent/permissions.js';

const DEFAULT_POLICY = {
  allow: [
    'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node',
    'python', 'python3', 'pip', 'pip3', 'pytest', 'ruff', 'black', 'mypy',
    'go', 'cargo', 'rustc', 'java', 'mvn', 'gradle', 'dotnet', 'php', 'composer',
    'ruby', 'bundle', 'rake',
    'git', 'make', 'jest', 'vitest', 'eslint', 'prettier', 'tsc', 'tsx',
    'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'echo', 'pwd',
    'mkdir', 'touch', 'cp', 'mv', 'rm', 'sed', 'awk', 'sort', 'uniq', 'diff'
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
  { pattern: /^(migrate|db:migrate|db:drop|db:reset)$/i, executable: null, risk: RISK.DESTRUCTIVE, why: 'changes database state' }
];

/** Paths a command must never be pointed at, even inside the workspace. */
const PROTECTED_PATHS = [/^\/(?!tmp)/, /^~/, /\.\.\//, /^\.git\/?$/, /node_modules\/\.bin/];

/**
 * @param {string} command
 * @returns {{ok:boolean, executable:string, args:string[], risk:string, reason?:string, why?:string}}
 */
export async function evaluateCommand(command) {
  const text = String(command || '').trim();
  if (!text) return { ok: false, reason: 'The command is empty' };
  if (text.length > 2000) return { ok: false, reason: 'The command is too long' };

  if (SHELL_INJECTION.test(text)) {
    return {
      ok: false,
      reason: 'Command chaining, redirection and substitution are not permitted. Run one command at a time.'
    };
  }

  const parts = tokenize(text);
  if (!parts.length) return { ok: false, reason: 'The command could not be parsed' };

  const [executable, ...args] = parts;
  const base = executable.split('/').pop();

  const policy = await systemSetting('sandbox.policy', DEFAULT_POLICY);
  const allow = new Set(policy.allow || DEFAULT_POLICY.allow);
  const deny = new Set(policy.deny || DEFAULT_POLICY.deny);
  const confirm = new Set(policy.confirm || DEFAULT_POLICY.confirm);

  if (deny.has(base)) {
    return { ok: false, executable: base, args, reason: `\`${base}\` is not permitted in the sandbox` };
  }
  if (!allow.has(base)) {
    return {
      ok: false, executable: base, args,
      reason: `\`${base}\` is not on the allowed command list. An administrator can add it in system settings.`
    };
  }

  for (const arg of args) {
    for (const rule of PROTECTED_PATHS) {
      if (rule.test(arg)) {
        return { ok: false, executable: base, args, reason: `\`${arg}\` points outside the project workspace` };
      }
    }
  }

  // Start at the lowest risk that fits, then escalate on argument patterns.
  let risk = /^(ls|cat|head|tail|grep|rg|find|wc|echo|pwd|diff|sort|uniq)$/.test(base) ? RISK.SAFE : RISK.WRITE;
  let why = null;

  if (confirm.has(base)) { risk = RISK.DESTRUCTIVE; why = `\`${base}\` can destroy work`; }

  for (const arg of args) {
    for (const rule of DANGEROUS_ARGS) {
      if (rule.executable && rule.executable !== base) continue;
      if (!rule.pattern.test(arg)) continue;
      if (rankRisk(rule.risk) > rankRisk(risk)) { risk = rule.risk; why = rule.why; }
    }
  }

  return { ok: true, executable: base, args, risk, why };
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
