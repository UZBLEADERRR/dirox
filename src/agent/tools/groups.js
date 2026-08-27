/**
 * Which tools travel, and which wait to be asked for.
 *
 * Measured on a sixteen-step coding run: 150,744 input tokens, of which
 * 75,776 — half — were tool schemas re-sent identically on every call. The
 * agent used eight of the forty-nine. The other forty-one were paid for
 * sixteen times each and never called.
 *
 * So the core travels and the rest is named. The model gets the tools a
 * coding step actually uses, plus one meta-tool that describes the groups it
 * can pull in. Asking costs one round trip, once, when a group is genuinely
 * needed; not asking saves roughly 3,400 tokens on every call for the whole
 * run.
 *
 * The choice of core is the whole design. Too small and the model spends a
 * round trip on the second step of every task; too large and the saving
 * evaporates. These eleven cover reading, changing, searching and running —
 * which is what almost every step of almost every task is.
 */

/** Always present. A step that needs none of these is rare. */
export const CORE_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_directory',
  'search_code', 'find_symbol',
  'execute_command', 'run_tests',
  'inspect_project',
  'load_tools'
];

/**
 * The rest, named by what a person would call them.
 *
 * The description is what the model reads when deciding whether to ask, so it
 * says what the group is *for* rather than listing its members.
 */
export const TOOL_GROUPS = {
  git: {
    summary: 'Local version control: status, diff, log, branch, commit, revert, push.',
    tools: ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit', 'git_revert', 'git_push']
  },
  github: {
    summary: 'The user\'s GitHub account: repositories, branches, pull requests, issues, commits, CI status, and opening a pull request.',
    tools: ['github_account', 'github_repositories', 'github_branches', 'github_pull_requests',
            'github_issues', 'github_commits', 'github_checks', 'github_read_file', 'github_open_pull_request']
  },
  database: {
    summary: 'The user\'s connected Supabase project: read the schema, query it, run SQL, apply a migration.',
    tools: ['supabase_status', 'supabase_schema', 'supabase_query', 'supabase_execute', 'supabase_apply_migration']
  },
  files: {
    summary: 'Less common file operations: create, delete, move, and search by filename.',
    tools: ['create_file', 'delete_file', 'move_file', 'search_files']
  },
  build: {
    summary: 'Building and dependencies: run a build, run the linter, install a package, audit dependencies.',
    tools: ['run_build', 'run_linter', 'install_dependency', 'dependency_audit', 'inspect_dependencies']
  },
  delivery: {
    summary: 'Handing files to the user, and using files they uploaded: send a download, place an upload in the project, list uploads.',
    tools: ['deliver_file', 'place_upload', 'list_uploads']
  },
  preview: {
    summary: 'Running the app and looking at it: start a dev server, read a page, photograph it in a real browser and get back what is measurably wrong with the layout, stop it.',
    tools: ['open_preview', 'inspect_page', 'screenshot_page', 'preview_status', 'close_preview']
  },
  memory: {
    summary: 'Remembering decisions and conventions across tasks, and recalling them.',
    tools: ['remember', 'recall']
  },
  web: {
    summary: 'The public internet: search for something, and read a page or a JSON endpoint. Use it when the answer is newer than your training or specific to a library, error or API you cannot see here.',
    tools: ['web_search', 'web_fetch']
  },
  automation: {
    summary: 'Work that runs later on its own: set up a schedule, see what is already scheduled.',
    tools: ['create_schedule', 'list_schedules']
  },
  security: {
    summary: 'Scanning the workspace for committed credentials.',
    tools: ['secret_scan']
  }
};

/** Every tool that belongs to a group, for deciding what is deferred. */
export const GROUPED_TOOL_NAMES = new Set(
  Object.values(TOOL_GROUPS).flatMap(group => group.tools)
);

export const GROUP_NAMES = Object.keys(TOOL_GROUPS);

/**
 * Groups worth loading before the model asks.
 *
 * A round trip costs more than a schema when we already know the answer: a
 * task that says "open a pull request" will need GitHub on its first step, and
 * making it ask is a wasted call in both directions.
 */
const HINTS = [
  [/\bgithub|pull request|\bPRs?\b|repositor|\bissues?\b|\bCI\b|workflow/i, 'github'],
  [/\bsupabase|database|schema|migration|\bSQL\b|\btable\b|postgres/i, 'database'],
  [/\bcommit|branch|\bgit\b|revert|merge\b/i, 'git'],
  [/\bzip\b|download|export|send me|\bapk\b|\bpdf\b|upload|logo|attach/i, 'delivery'],
  [/\bbuild\b|\bcompile|dependenc|\binstall\b|\bnpm i\b|lint/i, 'build'],
  [/\bpreview|screenshot|render|browser|\bpage\b|\bUI\b|looks?\b|design|layout|mobile|responsive/i, 'preview'],
  [/\bsecret|credential|leak|\.env\b/i, 'security'],
  // A task that names the outside world will need the outside world on its
  // first step; making it ask for the group is a wasted round trip.
  [/\bsearch\b|\bgoogle\b|look ?up|latest|documentation|\bdocs\b|changelog|release notes|https?:\/\/|\bAPI\b|\bweb\b/i, 'web'],
  [/\bschedule|every (day|week|month|morning|monday|hour)|\bcron\b|\bdaily\b|\bweekly\b|\bnightly\b|automat|recurring|periodic/i, 'automation']
];

/**
 * @param {string} objective
 * @returns {string[]} group names the task text already asks for
 */
export function groupsFor(objective) {
  const text = String(objective || '');
  const groups = new Set();
  for (const [pattern, group] of HINTS) {
    if (pattern.test(text)) groups.add(group);
  }
  return [...groups];
}

/** The description the model reads when deciding what to ask for. */
export function groupCatalogue(available = GROUP_NAMES) {
  return available
    .filter(name => TOOL_GROUPS[name])
    .map(name => `${name}: ${TOOL_GROUPS[name].summary}`)
    .join('\n');
}

export function toolNamesForGroups(groups = []) {
  return groups.flatMap(name => TOOL_GROUPS[name]?.tools ?? []);
}
