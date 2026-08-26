/** Task history across the organization, filterable by project and status. */

import { h, icon, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { renderInShell } from '../components/shell.js';
import { formatCost, formatDuration, relativeTime } from '../lib/format.js';
import { toastError } from '../lib/toast.js';

const STATUS = {
  completed: ['Completed', 'badge--success'],
  failed: ['Failed', 'badge--danger'],
  cancelled: ['Cancelled', ''],
  running: ['Running', 'badge--accent'],
  planning: ['Planning', 'badge--accent'],
  testing: ['Testing', 'badge--accent'],
  queued: ['Queued', ''],
  waiting_for_approval: ['Needs approval', 'badge--warning']
};

const MODE_ICON = { agent: 'sparkle', ask: 'chat', debug: 'search', review: 'shield', plan: 'tasks', edit: 'file', autopilot: 'play' };

function taskRow(task) {
  const [label, variant] = STATUS[task.status] || [task.status, ''];
  const live = ['running', 'planning', 'testing'].includes(task.status);

  return h('a.card.card--interactive', {
    href: `/app/tasks/${task.id}`,
    style: { display: 'flex', gap: 'var(--s-4)', alignItems: 'center', padding: 'var(--s-4)' }
  },
    h('span', { style: { color: 'var(--text-subtle)', flex: 'none' } }, icon(MODE_ICON[task.mode] || 'tasks', { size: 16 })),

    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div.truncate', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text-strong)', fontWeight: '500' } }, task.title),
      h('div.subtle', { style: { fontSize: 'var(--fs-2xs)', marginTop: '3px' } },
        [
          task.projectName,
          task.mode,
          task.changedFiles?.length ? `${task.changedFiles.length} files` : null,
          task.durationMs ? formatDuration(task.durationMs) : null,
          relativeTime(task.createdAt)
        ].filter(Boolean).join(' · '))
    ),

    task.costMicros ? h('span.mono.subtle', { style: { flex: 'none' } }, formatCost(task.costMicros)) : null,
    h('span.badge', { class: variant },
      live ? h('span.dot.dot--pulse') : null,
      label)
  );
}

export async function render({ query = {} }) {
  const content = h('div.view__inner');
  renderInShell(content, { title: 'Tasks', crumbs: [['Tasks', null]] });

  const list = h('div.stack--tight', { class: 'stack' });
  let status = query.status || '';

  const filters = h('div.tabs', { role: 'tablist' },
    [['', 'All'], ['running', 'Running'], ['waiting_for_approval', 'Needs approval'], ['completed', 'Completed'], ['failed', 'Failed']]
      .map(([value, label]) => h('button.tab', {
        role: 'tab',
        'aria-selected': String(value === status),
        onClick: () => {
          status = value;
          for (const tab of filters.children) tab.setAttribute('aria-selected', String(tab.textContent === label));
          load();
        }
      }, label))
  );

  mount(content,
    h('div.page-head',
      h('h1.page-head__title', 'Tasks'),
      h('p.page-head__sub', 'Everything DiroxCode has worked on, with what it cost and what it changed.')
    ),
    filters,
    h('div', { style: { marginTop: 'var(--s-5)' } }, list)
  );

  async function load() {
    mount(list, h('div.skeleton', { style: { height: '68px' } }), h('div.skeleton', { style: { height: '68px' } }));
    try {
      const { tasks } = await api.get(`/tasks?limit=60${status ? `&status=${status}` : ''}`);
      if (!tasks.length) {
        return mount(list, h('div.card.empty',
          h('div.empty__title', status ? 'Nothing here' : 'No tasks yet'),
          h('p.empty__body', status
            ? 'No task currently has that status.'
            : 'Open a project and describe what you want built. Every run appears here with its cost and its changes.'),
          status ? null : h('a.btn.btn--primary', { href: '/app/projects' }, 'Open a project')
        ));
      }
      mount(list, tasks.map(taskRow));
    } catch (error) {
      toastError(error, 'Tasks could not be loaded');
      mount(list, h('div.empty', h('p.empty__body', error.message)));
    }
  }

  await load();
}
