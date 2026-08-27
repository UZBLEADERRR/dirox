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
import { getIntegrationToken, revokeIntegration } from '../../modules/projects/github.js';
import {
  getViewer, listRepositories, listBranches, listPullRequests, listIssues,
  listCommits, checkStatus, getFileContent, createPullRequest,
  createRepository, putFile
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

/**
 * Call GitHub, and believe it about the token.
 *
 * A 401 means the token is dead — revoked in the user's settings, or expired —
 * not that the request was unlucky. Clearing the stored connection makes the
 * whole product agree at once: settings offers Connect again, and the next run
 * is not handed tools that can only return "Bad credentials".
 */
async function call(ctx, fn) {
  const value = await token(ctx);
  try {
    return await fn(value);
  } catch (error) {
    if (error?.status === 401) {
      await revokeIntegration(ctx.userId, 'github').catch(() => {});
      throw badRequest(
        'GitHub rejected the stored credentials, so the connection has been cleared. '
        + 'Ask the user to connect GitHub again in Settings → Developer — the access was revoked or has expired.'
      );
    }
    throw error;
  }
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
      const viewer = await call(ctx, getViewer);
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
      const repos = await call(ctx, key => listRepositories(key, { query: query || '', perPage: limit }));
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
      const branches = await call(ctx, key => listBranches(key, name));
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
      const pulls = await call(ctx, key => listPullRequests(key, name, { state: args.state, perPage: args.limit }));
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
      const issues = await call(ctx, key => listIssues(key, name, { state: args.state, perPage: args.limit }));
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
      const commits = await call(ctx, key => listCommits(key, name, { ref: args.ref, perPage: args.limit }));
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
      const result = await call(ctx, key => checkStatus(key, name, args.ref));
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
      const content = await call(ctx, key => getFileContent(key, name, args.path, args.ref));
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
  },

  {
    name: 'github_create_repository',
    // It makes something on the user's account under their name. That is not
    // an edit to a working copy, and it should not happen without them seeing.
    risk: RISK.OUTWARD,
    description:
      'Create a new repository on the connected GitHub account. Use this when the user asks for something to be put on GitHub that does not exist yet — a new bot, a new service, a new project. '
      + 'It comes back with a first commit and a default branch, ready for github_write_file or a push.',
    schema: t.object({
      name: t.string({ required: true, max: 100, description: 'Repository name, for example "telegram-order-bot"' }),
      description: t.string({ max: 350, description: 'One line on what it is' }),
      private: t.boolean({ default: true, description: 'Private unless the user asked for it to be public' })
    }),
    async run(args, ctx) {
      // GitHub is stricter than the message will be: a name with spaces gets
      // silently rewritten, which produces a repository nobody can find again.
      const name = String(args.name).trim().replace(/\s+/g, '-');
      if (!/^[\w.-]{1,100}$/.test(name)) {
        throw badRequest(`"${args.name}" is not a repository name. Use letters, numbers, dots, dashes and underscores.`);
      }

      const repo = await call(ctx, key => createRepository(key, {
        name, description: args.description, isPrivate: args.private !== false
      }));

      return {
        output: [
          `Created ${repo.full_name}${repo.private ? ' (private)' : ' (public)'}.`,
          repo.html_url,
          `Default branch: ${repo.default_branch}. Clone URL: ${repo.clone_url}`,
          'Add files with github_write_file, or set it as this project\'s remote and push.'
        ].join('\n'),
        metadata: { fullName: repo.full_name, url: repo.html_url, cloneUrl: repo.clone_url, defaultBranch: repo.default_branch }
      };
    }
  },

  {
    name: 'github_write_file',
    risk: RISK.OUTWARD,
    description:
      'Commit one file straight to a GitHub repository, creating or replacing it. '
      + 'Use this for a handful of files in a repository you are not working in locally — a new bot\'s source, a README, a workflow. For a repository checked out here, edit and push instead.',
    schema: t.object({
      repository: t.string({ max: 140, description: 'owner/name; defaults to this project\'s repository' }),
      path: t.string({ required: true, max: 300, description: 'Path inside the repository' }),
      content: t.string({ required: true, max: 200_000 }),
      message: t.string({ max: 200, description: 'Commit message' }),
      branch: t.string({ max: 120, description: 'Defaults to the repository\'s default branch' })
    }),
    async run(args, ctx) {
      const name = repository(args.repository, ctx);
      const path = String(args.path).replace(/^\/+/, '');
      if (!path || path.includes('..')) throw badRequest('Give a path inside the repository.');

      const result = await call(ctx, key => putFile(key, name, path, {
        content: args.content,
        message: args.message || `Add ${path}`,
        branch: args.branch
      }));

      return {
        output: `Committed ${path} to ${name}${args.branch ? ` on ${args.branch}` : ''}.\n${result.commit?.html_url ?? ''}`,
        metadata: { path, repository: name, sha: result.content?.sha }
      };
    }
  }
];

export const GITHUB_TOOL_NAMES = new Set(githubTools.map(tool => tool.name));
