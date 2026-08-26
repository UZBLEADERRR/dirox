/**
 * Tool permission model.
 *
 * Every tool declares a risk level. The organization's trust setting decides
 * whether a given risk level runs immediately or waits for a human.
 *
 *   safe        read-only. Always allowed.
 *   write       modifies files in the workspace. Allowed unless trust is SAFE.
 *   install     changes dependencies. Needs approval unless AUTONOMOUS.
 *   destructive deletes or resets. Always needs approval.
 *   outward     leaves the workspace (git push, pull request). Always needs approval.
 *
 * `AUTONOMOUS` never covers destructive or outward-facing actions. A trust
 * setting is a convenience, not a way to remove the boundary that matters.
 */

export const RISK = {
  SAFE: 'safe',
  WRITE: 'write',
  INSTALL: 'install',
  DESTRUCTIVE: 'destructive',
  OUTWARD: 'outward'
};

export const TRUST = {
  SAFE: 'safe',              // ask before any modification
  CONFIRM: 'confirm',        // edits run, everything riskier asks
  AUTONOMOUS: 'autonomous'   // edits and installs run; destructive/outward still ask
};

const MATRIX = {
  [TRUST.SAFE]: { safe: 'allow', write: 'ask', install: 'ask', destructive: 'ask', outward: 'ask' },
  [TRUST.CONFIRM]: { safe: 'allow', write: 'allow', install: 'ask', destructive: 'ask', outward: 'ask' },
  [TRUST.AUTONOMOUS]: { safe: 'allow', write: 'allow', install: 'allow', destructive: 'ask', outward: 'ask' }
};

/**
 * @param {{risk:string}} tool
 * @param {{trust?:string, mode?:string, role?:string}} context
 * @returns {{decision:'allow'|'ask'|'deny', reason?:string}}
 */
export function decide(tool, { trust = TRUST.CONFIRM, mode = 'agent', role = 'member' } = {}) {
  const risk = tool.risk || RISK.SAFE;

  // A read-only role can never cause a write, whatever the trust setting says.
  if (role === 'viewer' && risk !== RISK.SAFE) {
    return { decision: 'deny', reason: 'Your role in this organization is read-only' };
  }

  // Read-only modes mean read-only, regardless of trust.
  if ((mode === 'ask' || mode === 'review' || mode === 'plan') && risk !== RISK.SAFE) {
    return { decision: 'deny', reason: `${mode} mode does not modify anything` };
  }

  const table = MATRIX[trust] || MATRIX[TRUST.CONFIRM];
  return { decision: table[risk] ?? 'ask' };
}

/** A human-readable description of what approval is being requested for. */
export function describeApproval(tool, args) {
  switch (tool.name) {
    case 'delete_file': return `Delete ${args.path}`;
    case 'move_file': return `Move ${args.from} to ${args.to}`;
    case 'execute_command': return `Run: ${args.command}`;
    case 'install_dependency': return `Install ${Array.isArray(args.packages) ? args.packages.join(', ') : args.packages}`;
    case 'git_commit': return `Commit: ${args.message}`;
    case 'git_push': return `Push to ${args.branch || 'the current branch'}`;
    case 'create_pull_request': return `Open a pull request: ${args.title}`;
    case 'git_reset': return `Reset the working tree to ${args.ref || 'HEAD'}`;
    default: return `${tool.name}(${Object.keys(args || {}).slice(0, 3).join(', ')})`;
  }
}

export { MATRIX };
