/**
 * GitHub tools.
 *
 * The product could already talk to GitHub — connect an account, list
 * repositories, open a pull request — but only through HTTP routes a person
 * clicks. The agent had none of it, so "check my GitHub" could not work no
 * matter how the request was phrased: there was nothing to call.
 *
 * These read the account the user connected, over their own token. Nothing
 * here needs a project: asking what repositories exist is a reasonable first
 * question, and it is asked before any of them has been opened.
 *
 * Everything is read-only except `github_open_pull_request`, which reaches
 * outside the workspace and therefore always asks.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest, notConfigured } from '../../core/errors.js';
import { getIntegrationToken } from '../../modules/projects/github.js';
import {
  getViewer, listRepositories, listBranches, listPullRequests, listIssues,
  listCommits, checkStatus, getFileContent, createPullRequest
} from '../../modules/projects/github.js';

/**
 * The caller's GitHub token, or a message a model can act on.
 *
 * A missing connection is an ordinary outcome, not an exception: the answer is
 * "connect your account", and the model should be able to say so.
 */
async function token(ctx) {
  if (!ctx.userId) throw notConfigured('a signed-in user');
  const value = await getIntegrationToken(ctx.userId, 'github').catch(() => null);
  if (!value) {
    throw badRequest('No GitHub account is connected. Connect one in Settings → Developer, then try again.');
  }
  return value;
}

/** Repository names are user input that becomes a URL path. */
function repository(fullName, ctx) {
  const name = String(fullName || ctx.project?.repository?.fullName || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) {
    throw badRequest('Give the repository as "owner/name", for example "acme/storefront".');
  }
  return name;
}

/** A compact table: the model reads rows, not JSON. */
function table(rows, columns) {
  if (!rows.length) return '(none)';
  return rows.map(row => columns.map(([, get]) => get(row)).filter(Boolean).join('  ·  ')).join('\n');
}

export const githubTools = [
  {
    name: 'github_account',
    risk: RISK.SAFE,
    description: 'Check which GitHub account is connected, and confirm the connection works.',
    schema: t.object({}),
    async run(_args, ctx) {
      const viewer = await getViewer(await token(ctx));
      return {
        output: `Connected as ${viewer.login}${viewer.name ? ` (${viewer.name})` : ''}${viewer.email ? ` · ${viewer.email}` : ''}`,
        metadata: { login: viewer.login }
      };
    }
  },

  {
    name: 'github_repositories',
    risk: RISK.SAFE,
    description: 'List the GitHub repositories this account can reach, most recently updated first. Optionally filter by name.',
    schema: t.object({
      query: t.string({ max: 100, description: 'Optional name filter' }),
      limit: t.integer({ min: 1, max: 50, default: 20 })
    }),
    async run({ query, limit }, ctx) {
      const repos = await listRepositories(await token(ctx), { query: query || '', perPage: limit });
      return {
        output: repos.length
          ? `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}:\n${table(repos, [
              ['name', repo => repo.fullName],
              ['visibility', repo => repo.private ? 'private' : 'public'],
              ['language', repo => repo.language || ''],
              ['branch', repo => repo.defaultBranch],
              ['updated', repo => String(repo.updatedAt || '').slice(0, 10)]
            ])}`
          : query ? `No repository matches "${query}".` : 'This account has no repositories.',
        metadata: { count: repos.length, names: repos.map(repo => repo.fullName) }
      };
    }
  },

  {
    name: 'github_branches',
    risk: RISK.SAFE,
    description: 'List the branches of a GitHub repository.',
    schema: t.object({
      repository: t.string({ max: 140, description: 'owner/name; defaults to the open project\'s repository' })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const branches = await listBranches(await token(ctx), name);
      return {
        output: `${name} — ${branches.length} branch(es):\n${branches.map(branch => `${branch.name}  ${branch.sha?.slice(0, 8) ?? ''}`).join('\n')}`,
        metadata: { count: branches.length }
      };
    }
  },

  {
    name: 'github_pull_requests',
    risk: RISK.SAFE,
    description: 'List pull requests on a GitHub repository.',
    schema: t.object({
      repository: t.string({ max: 140 }),
      state: t.enum(['open', 'closed', 'all'], { default: 'open' }),
      limit: t.integer({ min: 1, max: 50, default: 20 })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const pulls = await listPullRequests(await token(ctx), name, { state: args.state, perPage: args.limit });
      return {
        output: `${name} — ${pulls.length} ${args.state} pull request(s):\n${table(pulls, [
          ['number', pull => `#${pull.number}`],
          ['title', pull => pull.title],
          ['state', pull => pull.state],
          ['author', pull => `by ${pull.author}`],
          ['branch', pull => `${pull.head} → ${pull.base}`]
        ])}`,
        metadata: { count: pulls.length, numbers: pulls.map(pull => pull.number) }
      };
    }
  },

  {
    name: 'github_issues',
    risk: RISK.SAFE,
    description: 'List issues on a GitHub repository. Pull requests are excluded.',
    schema: t.object({
      repository: t.string({ max: 140 }),
      state: t.enum(['open', 'closed', 'all'], { default: 'open' }),
      limit: t.integer({ min: 1, max: 50, default: 20 })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const issues = await listIssues(await token(ctx), name, { state: args.state, perPage: args.limit });
      return {
        output: `${name} — ${issues.length} ${args.state} issue(s):\n${table(issues, [
          ['number', issue => `#${issue.number}`],
          ['title', issue => issue.title],
          ['labels', issue => issue.labels.length ? issue.labels.join(', ') : ''],
          ['comments', issue => issue.comments ? `${issue.comments} comment(s)` : '']
        ])}`,
        metadata: { count: issues.length }
      };
    }
  },

  {
    name: 'github_commits',
    risk: RISK.SAFE,
    description: 'List recent commits on a branch of a GitHub repository.',
    schema: t.object({
      repository: t.string({ max: 140 }),
      ref: t.string({ max: 100, description: 'Branch or sha; defaults to the default branch' }),
      limit: t.integer({ min: 1, max: 50, default: 15 })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const commits = await listCommits(await token(ctx), name, { ref: args.ref, perPage: args.limit });
      return {
        output: `${name}${args.ref ? ` @ ${args.ref}` : ''}:\n${commits.map(commit =>
          `${commit.sha}  ${commit.message}  — ${commit.author}, ${String(commit.date || '').slice(0, 10)}`).join('\n')}`,
        metadata: { count: commits.length }
      };
    }
  },

  {
    name: 'github_checks',
    risk: RISK.SAFE,
    description: 'Report whether CI is passing on a branch or commit, and name what is failing.',
    schema: t.object({
      repository: t.string({ max: 140 }),
      ref: t.string({ required: true, max: 100, description: 'Branch name or commit sha' })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const result = await checkStatus(await token(ctx), name, args.ref);
      const summary = result.failing.length
        ? `Failing: ${result.failing.join(', ')}`
        : result.checks.length ? 'All checks passed.' : 'No checks reported for this ref.';
      return {
        ok: result.failing.length === 0,
        output: `${name} @ ${args.ref} — ${result.state}\n${summary}\n\n${table(result.checks, [
          ['name', check => check.name],
          ['conclusion', check => check.conclusion || check.status]
        ])}`,
        metadata: { state: result.state, failing: result.failing }
      };
    }
  },

  {
    name: 'github_read_file',
    risk: RISK.SAFE,
    description: 'Read one file from a GitHub repository without cloning it. Use this to look at a repository that is not an open project.',
    schema: t.object({
      repository: t.string({ max: 140 }),
      path: t.string({ required: true, max: 300 }),
      ref: t.string({ max: 100 })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const content = await getFileContent(await token(ctx), name, args.path, args.ref);
      if (content === null) {
        return { ok: false, output: `${args.path} is not a text file, or does not exist in ${name}.` };
      }
      return {
        output: `${name}:${args.path}\n\n${content}`,
        metadata: { bytes: content.length }
      };
    }
  },

  {
    name: 'github_open_pull_request',
    // Outward: it publishes to a repository other people can see, so it asks
    // whatever the trust level.
    risk: RISK.OUTWARD,
    description: 'Open a pull request on GitHub from one branch into another.',
    schema: t.object({
      repository: t.string({ max: 140 }),
      title: t.string({ required: true, max: 200 }),
      head: t.string({ required: true, max: 100, description: 'The branch holding the change' }),
      base: t.string({ max: 100, description: 'The branch to merge into; defaults to the repository default' }),
      body: t.string({ max: 8000, truncate: true })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const accessToken = await token(ctx);
      const base = args.base || ctx.project?.repository?.defaultBranch || 'main';
      const pull = await createPullRequest(accessToken, name, {
        title: args.title, head: args.head, base, body: args.body
      });
      return {
        output: `Opened ${name}#${pull.number}: ${pull.title}\n${pull.html_url}`,
        metadata: { number: pull.number, url: pull.html_url }
      };
    }
  }
];

export const GITHUB_TOOL_NAMES = new Set(githubTools.map(tool => tool.name));
