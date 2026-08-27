/**
 * The facts a run always needs, worked out without asking a model.
 *
 * Watch what an agent does on the first step of almost any coding task: it
 * calls `inspect_project`, or lists the root directory, or runs `git status`.
 * It is finding out what kind of repository it is in. The answer is the same
 * every time, it is computed by code rather than judged by a model, and yet
 * getting it costs a full iteration — one model call carrying the whole
 * system prompt and every tool schema, then a tool round trip, then another
 * model call to make use of it.
 *
 * So the run works it out first and hands it over. Roughly three hundred
 * tokens, added once, in place of an iteration that costs thousands.
 *
 * The rule this follows is worth stating because it generalises: if the answer
 * does not depend on the model's judgement, the model should not be spending a
 * turn to obtain it. Nothing here is a decision. It is `ls`, a manifest and a
 * branch name.
 *
 * Everything is best-effort. A brief that fails is a brief that is left out —
 * an orientation step is a convenience, and a run must not fail because a
 * workspace has no git in it.
 */

import { detectProject } from '../context/detect.js';
import { listWorkspace } from '../exec/workspace.js';
import { runCommand } from '../exec/sandbox.js';

/** Directories that say something about the repository's shape. */
const LAYOUT_LIMIT = 12;

/** Top-level files worth naming, in the order a person would look for them. */
const NOTABLE = [
  'package.json', 'pnpm-workspace.yaml', 'requirements.txt', 'pyproject.toml',
  'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle',
  'Dockerfile', 'docker-compose.yml', 'Makefile', 'README.md', 'CLAUDE.md',
  '.env.example', 'tsconfig.json', 'vite.config.js', 'next.config.js'
];

/**
 * Where the work stands in version control.
 *
 * One command, and its failure is not interesting: a workspace materialised
 * from object storage has no git history, and that is a normal state rather
 * than a problem to report.
 */
async function gitSummary(projectId) {
  try {
    const result = await runCommand(projectId, 'git status --porcelain=v1 -b', { timeoutMs: 8000 });
    const lines = String(result.stdout || '').split('\n').filter(Boolean);
    const branchLine = lines.find(line => line.startsWith('##'));
    const branch = branchLine?.replace(/^##\s*/, '').split(/\.{3}|\s/)[0] || null;
    const changes = lines.filter(line => !line.startsWith('##'));

    if (!branch) return null;
    return changes.length
      ? `Git: on ${branch}, ${changes.length} uncommitted change(s): ${changes.slice(0, 6).map(line => line.slice(3)).join(', ')}${changes.length > 6 ? ', …' : ''}`
      : `Git: on ${branch}, working tree clean`;
  } catch {
    return null;
  }
}

/**
 * What kind of repository is this, and what state is it in?
 *
 * @param {string} projectId
 * @returns {Promise<string|null>} a compact brief, or null if nothing is known
 */
export async function orientation(projectId) {
  if (!projectId) return null;

  const [detected, listing, git] = await Promise.all([
    detectProject(projectId).catch(() => null),
    listWorkspace(projectId, { maxEntries: 3000, includeDirectories: true }).catch(() => ({ entries: [] })),
    gitSummary(projectId)
  ]);

  const entries = listing?.entries ?? [];
  if (!entries.length && !detected) return null;

  /*
     Directories by how many files are under them: the shape of the repository
     in one line, which is what a person reads a tree for.

     Files only. Counting the nested directories as well would make `src/ (6)`
     out of four files and two folders, and a count that does not mean what it
     says is worse than no count.
  */
  const roots = new Map();
  const topLevel = new Set();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const [root, ...rest] = entry.path.split('/');
    if (rest.length) roots.set(root, (roots.get(root) || 0) + 1);
    else topLevel.add(root);
  }

  const layout = [...roots.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LAYOUT_LIMIT)
    .map(([directory, count]) => `${directory}/ (${count})`);

  const notable = NOTABLE.filter(name => topLevel.has(name));

  const lines = [
    detected?.language && `Language: ${detected.language}${detected.framework ? ` · ${detected.framework}` : ''}${detected.packageManager ? ` · ${detected.packageManager}` : ''}`,
    [
      detected?.testCommand && `test: ${detected.testCommand}`,
      detected?.buildCommand && `build: ${detected.buildCommand}`,
      detected?.devCommand && `dev: ${detected.devCommand}`
    ].filter(Boolean).join(' · ') || null,
    layout.length && `Layout: ${layout.join(', ')}`,
    notable.length && `Root files: ${notable.join(', ')}`,
    detected?.entryPoints?.length && `Entry points: ${detected.entryPoints.slice(0, 5).join(', ')}`,
    git
  ].filter(Boolean);

  if (!lines.length) return null;

  // Named as what it is. A model that mistakes this for something it worked
  // out itself will not re-check anything it should re-check.
  return `Project (established before this run started, not by looking):\n${lines.join('\n')}`;
}

export { gitSummary, NOTABLE };
