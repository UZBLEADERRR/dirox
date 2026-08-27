/**
 * Agent activity timeline.
 *
 * Shows what the agent actually did — files read, actions taken, tests run —
 * as a collapsible list of concise summaries. It never shows raw model
 * reasoning, because that is neither safe to expose nor useful to read.
 */

import { h, icon, mount, clear } from '../lib/dom.js';
import { formatCost, formatDuration, formatTokens } from '../lib/format.js';

const PHASE_LABEL = {
  classify: 'Understanding',
  plan: 'Planning',
  retrieve: 'Reading the codebase',
  model: 'Working',
  tool: 'Acting',
  observe: 'Observing',
  validate: 'Validating',
  review: 'Reviewing',
  checkpoint: 'Checkpoint',
  delegate: 'Delegating',
  finalize: 'Finishing'
};

/** What each sub-agent is doing, in words a person would use. */
const ROLE_LABEL = {
  explore: 'Looking into',
  implement: 'Building',
  verify: 'Testing',
  review: 'Reviewing'
};

export function createActivity({ onFileClick } = {}) {
  const list = h('ol.activity', { 'aria-label': 'Agent activity', 'aria-live': 'polite' });
  const rows = new Map();

  function rowFor(key) {
    if (rows.has(key)) return rows.get(key);
    const row = {
      title: h('div.activity__title'),
      detail: h('div.activity__detail'),
      expand: null
    };
    row.element = h('li.activity__row', { 'data-status': 'active' },
      h('span.activity__dot'),
      h('div.activity__body', row.title, row.detail)
    );
    rows.set(key, row);
    list.appendChild(row.element);
    return row;
  }

  return {
    element: list,

    /** A pipeline step: planning, retrieving, validating and so on. */
    step({ index, phase, title, status, summary, durationMs, detail }) {
      const row = rowFor(`step:${index}`);
      row.element.dataset.status = status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'active';
      mount(row.title, title || PHASE_LABEL[phase] || phase);
      mount(row.detail,
        summary || '',
        durationMs > 1200 ? h('span.subtle', ` · ${formatDuration(durationMs)}`) : null
      );

      // Retrieval and planning carry detail worth being able to open.
      if (detail?.files?.length && onFileClick) {
        if (!row.expand) {
          row.expand = h('div.activity__expand', { hidden: true });
          row.element.querySelector('.activity__body').appendChild(row.expand);
          const toggle = h('button.btn.btn--ghost.btn--sm', {
            style: { padding: '0', height: 'auto', fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)' },
            onClick: () => { row.expand.hidden = !row.expand.hidden; }
          }, 'Show files');
          row.detail.appendChild(h('span', ' · '), toggle);
        }
        mount(row.expand, detail.files.slice(0, 20).map(path =>
          h('div', h('button.file-ref', { onClick: () => onFileClick(path) }, path))));
      }
    },

    /** A tool call. */
    tool({ id, name, status, summary, description }) {
      const row = rowFor(`tool:${id}`);
      row.element.dataset.status =
        status === 'completed' ? 'done'
        : status === 'failed' || status === 'denied' ? 'failed'
        : status === 'awaiting_approval' ? 'active'
        : 'active';

      mount(row.title, toolLabel(name), description ? h('span.mono.subtle', ` ${truncate(description, 60)}`) : null);
      mount(row.detail, summary || (status === 'running' ? 'Running…' : ''));
    },

    /** Which files were read, and how many tokens that cost. */
    context({ files, tokens, truncated }) {
      const row = rowFor('context');
      row.element.dataset.status = 'done';
      mount(row.title, 'Read the codebase');
      mount(row.detail,
        `${files.length} file${files.length === 1 ? '' : 's'} · ${formatTokens(tokens)} tokens`,
        truncated ? h('span.subtle', ' · more available on request') : null
      );

      if (onFileClick && files.length) {
        if (!row.expand) {
          row.expand = h('div.activity__expand', { hidden: true });
          row.element.querySelector('.activity__body').appendChild(row.expand);
          const toggle = h('button.btn.btn--ghost.btn--sm', {
            style: { padding: '0', height: 'auto', fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)' },
            onClick: () => { row.expand.hidden = !row.expand.hidden; }
          }, 'Show');
          row.detail.appendChild(h('span', ' · '), toggle);
        }
        mount(row.expand, files.map(file =>
          h('div', h('button.file-ref', { onClick: () => onFileClick(file.path) }, file.path),
            file.lines ? h('span.subtle', ` lines ${file.lines}`) : null)));
      }
    },

    /**
     * A delegated job.
     *
     * Worth its own row rather than folding into the tool list: from the
     * user's side this is the agent saying "I sent someone to find out", and
     * the cost of that answer belongs next to it.
     */
    delegate({ role, objective, status, steps, changed, costMicros }) {
      const row = rowFor(`delegate:${role}:${String(objective).slice(0, 60)}`);
      row.element.dataset.status = status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'active';
      mount(row.title, `${ROLE_LABEL[role] || 'Delegated'}: ${truncate(objective, 70)}`);
      mount(row.detail, status === 'completed'
        ? [
          `${steps} step${steps === 1 ? '' : 's'}`,
          changed ? ` · ${changed} file${changed === 1 ? '' : 's'} changed` : '',
          costMicros ? ` · ${formatCost(costMicros)}` : ''
        ].join('')
        : status === 'failed' ? 'Did not finish' : 'Working…');
    },

    notice({ level, message }) {
      const row = rowFor(`notice:${message.slice(0, 40)}`);
      row.element.dataset.status = level === 'warning' ? 'failed' : 'done';
      mount(row.title, message);
      mount(row.detail, '');
    },

    model({ name, level, escalated }) {
      const row = rowFor('model');
      row.element.dataset.status = 'done';
      mount(row.title, escalated ? `Switched to ${name}` : `Using ${name}`);
      mount(row.detail, level ? `complexity ${level.replace('level', 'L')}` : '');
    },

    done({ summary, changedFiles, validation, budget }) {
      const row = rowFor('done');
      row.element.dataset.status = 'done';
      mount(row.title, 'Completed');
      const parts = [];
      if (changedFiles?.length) parts.push(`${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed`);
      if (validation) parts.push(validation.passed ? 'tests passed' : 'tests failing');
      if (budget?.spentMicros) parts.push(formatCost(budget.spentMicros));
      mount(row.detail, parts.join(' · '));
    },

    failed(message) {
      const row = rowFor('done');
      row.element.dataset.status = 'failed';
      mount(row.title, 'Stopped');
      mount(row.detail, message || '');
    },

    clear() { rows.clear(); clear(list); },
    get count() { return rows.size; }
  };
}

const TOOL_LABEL = {
  read_file: 'Read', write_file: 'Wrote', edit_file: 'Edited', create_file: 'Created',
  delete_file: 'Deleted', move_file: 'Moved', search_files: 'Searched files',
  search_code: 'Searched code', find_symbol: 'Located', list_directory: 'Listed',
  execute_command: 'Ran', run_tests: 'Ran tests', run_build: 'Built',
  run_linter: 'Linted', install_dependency: 'Installed',
  git_status: 'Checked git', git_diff: 'Reviewed the diff', git_log: 'Read history',
  git_branch: 'Branched', git_commit: 'Committed', git_push: 'Pushed', git_revert: 'Reverted',
  inspect_project: 'Inspected the project', inspect_dependencies: 'Checked dependencies',
  remember: 'Remembered', recall: 'Recalled',
  dependency_audit: 'Audited dependencies', secret_scan: 'Scanned for secrets'
};

function toolLabel(name) { return TOOL_LABEL[name] || name; }
function truncate(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export { PHASE_LABEL, toolLabel };
