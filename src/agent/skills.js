/**
 * Skills: the parts of doing a job well that do not fit in a system prompt.
 *
 * A system prompt has to be true of every request, so it can only ever hold
 * general instructions — be careful, cite paths, do not invent APIs. The
 * specific knowledge that separates a competent piece of work from a plausible
 * one is not general: how to choose a colour that stays legible in both
 * themes, what a test has to assert to be worth writing, how to find a bug
 * rather than guess at it. Putting all of that in the prompt would cost
 * thousands of tokens on every message, including "salom".
 *
 * So a skill is a document, and the agent asks for it when the work calls for
 * it. The same trade as tool groups: an index of one line each travels, and a
 * body is fetched once, by name, when it is genuinely needed.
 *
 * Two sources, and the order matters:
 *
 *   built in     shipped with the platform, in `skills/`. Craft that applies
 *                to any project.
 *   the project  `.dirox/skills/*.md` in the user's own repository. Their
 *                conventions, their design system, their deployment steps —
 *                and they win, because a house style beats a general one.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInside } from '../exec/workspace.js';
import { logger } from '../core/logger.js';

/** Where the platform's own skills live. */
const BUILT_IN = join(dirname(fileURLToPath(import.meta.url)), '../../skills');

/** Where a project keeps its own. */
const PROJECT_DIRECTORY = '.dirox/skills';

/** A skill body larger than this is a document, not a skill. */
const MAX_BODY_CHARS = 24_000;

/**
 * Front matter, read strictly.
 *
 * Three keys and nothing else, because a skill format that grows keys grows a
 * parser, and this one has to stay small enough that anybody can write a skill
 * in a text editor without reading documentation.
 */
export function parseSkill(text, fallbackName) {
  const source = String(text || '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!match) {
    return { name: fallbackName, description: '', when: '', body: source.trim() };
  }

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (pair) meta[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, '');
  }

  return {
    name: (meta.name || fallbackName).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    description: (meta.description || '').slice(0, 300),
    when: (meta.when || '').slice(0, 300),
    body: match[2].trim().slice(0, MAX_BODY_CHARS)
  };
}

async function readSkillFile(path, fallbackName) {
  const text = await readFile(path, 'utf8');
  return parseSkill(text, fallbackName);
}

/** The platform's own skills, read from disk once per process. */
let builtInCache = null;

export async function builtInSkills() {
  if (builtInCache) return builtInCache;

  const skills = [];
  try {
    for (const entry of await readdir(BUILT_IN, { withFileTypes: true })) {
      const path = entry.isDirectory()
        ? join(BUILT_IN, entry.name, 'SKILL.md')
        : entry.name.endsWith('.md') ? join(BUILT_IN, entry.name) : null;
      if (!path) continue;

      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;

      const skill = await readSkillFile(path, basename(entry.name, '.md'));
      if (skill.body) skills.push({ ...skill, source: 'built-in' });
    }
  } catch (error) {
    logger.debug('no built-in skills directory', { reason: error?.message });
  }

  builtInCache = skills.sort((a, b) => a.name.localeCompare(b.name));
  return builtInCache;
}

/** For tests, and for a deployment that adds skills without a restart. */
export function resetSkillCache() { builtInCache = null; }

/**
 * A project's own skills, which override the platform's by name.
 *
 * Read fresh every time: a repository is a moving target, and a skill the
 * agent wrote three steps ago should be loadable on the fourth.
 */
export async function projectSkills(projectId) {
  if (!projectId) return [];

  const skills = [];
  try {
    const directory = await resolveInside(projectId, PROJECT_DIRECTORY);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const skill = await readSkillFile(join(directory, entry.name), basename(entry.name, '.md'));
      if (skill.body) skills.push({ ...skill, source: 'project' });
    }
  } catch {
    // A project without a skills directory is the normal case.
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything available, with the project's version of a name winning.
 *
 * @returns {Promise<Array<{name, description, when, body, source}>>}
 */
export async function availableSkills(projectId) {
  const [platform, project] = await Promise.all([builtInSkills(), projectSkills(projectId)]);

  const byName = new Map(platform.map(skill => [skill.name, skill]));
  // Last write wins, and the project writes last on purpose: a house style
  // beats a general one, and a team that disagrees with ours should be able
  // to say so in a file rather than in every message.
  for (const skill of project) byName.set(skill.name, skill);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The index the model reads when deciding whether to ask for one.
 *
 * One line each. `when` rather than `description`, because the decision the
 * model is making is "does this apply to what I am doing", not "what is this".
 */
export function skillIndex(skills) {
  if (!skills.length) return '';
  const lines = skills.map(skill => `- ${skill.name}: ${skill.when || skill.description}`);
  return `Skills you can load with load_skill, when the work calls for one:\n${lines.join('\n')}`;
}

export async function loadSkill(name, projectId) {
  const wanted = String(name || '').toLowerCase().trim();
  const skills = await availableSkills(projectId);
  return skills.find(skill => skill.name === wanted) ?? null;
}

export { BUILT_IN, PROJECT_DIRECTORY, MAX_BODY_CHARS };
