/**
 * Overview.
 *
 * Not the landing page — chat is. This is the page you open when you want the
 * numbers: what you have been doing, what it cost, and what to pick back up.
 * Deliberately quiet, and every number shown is read from the API.
 */

import { h, icon, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { renderInShell, loadSidebarData } from '../components/shell.js';
import { formatCost, formatTokens, relativeTime, pluralize } from '../lib/format.js';
import { toastError } from '../lib/toast.js';
import { openNewProject } from '../components/new-project.js';

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name.split(' ')[0]}` : part;
}

const STATUS_VARIANT = {
  completed: 'success', failed: 'danger', cancelled: '', running: 'accent',
  planning: 'accent', testing: 'accent', queued: '', waiting_for_approval: 'warning'
};

function taskRow(task) {
  return h('a.card.card--interactive', {
    href: `/app/tasks/${task.id}`,
    style: { display: 'flex', gap: 'var(--s-3)', alignItems: 'center', padding: 'var(--s-3) var(--s-4)' }
  },
    h('span.dot', { class: task.status === 'completed' ? 'dot--success' : task.status === 'failed' ? 'dot--danger' : ['running', 'planning', 'testing'].includes(task.status) ? 'dot--pulse' : '' }),
    h('div', { style: { minWidth: '0', flex: '1' } },
      h('div.truncate', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text)' } }, task.title),
      h('div.subtle', { style: { fontSize: 'var(--fs-2xs)', marginTop: '2px' } },
        [task.projectName, relativeTime(task.createdAt)].filter(Boolean).join(' · '))
    ),
    task.costMicros ? h('span.mono.subtle', formatCost(task.costMicros)) : null,
    h('span.badge', { class: STATUS_VARIANT[task.status] ? `badge--${STATUS_VARIANT[task.status]}` : '' },
      task.status.replace(/_/g, ' '))
  );
}

function projectCard(project) {
  const ready = project.indexStatus === 'ready';
  return h('a.card.card--interactive', { href: `/app/projects/${project.id}`, style: { display: 'block' } },
    h('div.row.row--between',
      h('div.row',
        icon('folder', { size: 15 }),
        h('span', { style: { fontWeight: '600', color: 'var(--text-strong)' } }, project.name)
      ),
      ready ? h('span.dot.dot--success') : project.indexStatus === 'running' ? h('span.dot.dot--pulse') : h('span.dot')
    ),
    h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--s-3)', minHeight: '1.5em' } },
      [project.framework, project.language].filter(Boolean).join(' · ') || 'Not yet analysed'),
    h('div.row', { style: { marginTop: 'var(--s-4)', fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)' } },
      h('span', project.fileCount ? pluralize(project.fileCount, 'file') : 'Indexing pending'),
      h('span', '·'),
      h('span', relativeTime(project.updatedAt))
    )
  );
}

function quickActions() {
  const actions = [
    ['New chat', 'chat', () => router.navigate('/app')],
    ['New project', 'plus', () => openNewProject()],
    ['Connect GitHub', 'git', () => openNewProject({ source: 'github' })],
    ['Open project', 'projects', () => router.navigate('/app/projects')]
  ];

  return h('div.grid.grid--4',
    actions.map(([label, iconName, run]) => h('button.card.card--interactive', {
      onClick: run,
      style: { textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }
    },
      h('span', { style: { color: 'var(--accent)' } }, icon(iconName, { size: 17 })),
      h('span', { style: { fontSize: 'var(--fs-sm)', fontWeight: '500', color: 'var(--text-strong)' } }, label)
    ))
  );
}

function usageStrip(usage) {
  if (!usage) return null;
  const items = [
    ['Tasks', String(usage.tasks ?? 0)],
    ['Tokens', formatTokens((usage.totals?.inputTokens || 0) + (usage.totals?.outputTokens || 0))],
    ['AI cost', formatCost(usage.totals?.costMicros || 0)],
    ['Projects', String(usage.projects ?? 0)]
  ];
  return h('div.grid.grid--4',
    items.map(([label, value]) => h('div.stat',
      h('div.stat__label', label),
      h('div.stat__value', value),
      h('div.stat__delta', 'last 30 days')
    ))
  );
}

export async function render() {
  const session = store.state.session;
  const content = h('div.view__inner');

  renderInShell(content, { title: 'Overview' });

  mount(content,
    h('div.page-head',
      h('h1.page-head__title', greeting(session?.profile?.fullName)),
      h('p.page-head__sub', 'Pick up where you left off, or give DiroxCode something new to build.')
    ),
    h('div.section', quickActions()),
    h('div.section', h('div.skeleton', { style: { height: '92px' } })),
    h('div.section', h('div.skeleton', { style: { height: '180px' } }))
  );

  try {
    const [{ projects }, { tasks }, usage] = await Promise.all([
      api.get('/projects?limit=6'),
      api.get('/tasks?limit=6'),
      api.get('/me/usage').catch(() => null)
    ]);
    store.set({ projects, usage });

    mount(content,
      h('div.page-head',
        h('h1.page-head__title', greeting(session?.profile?.fullName)),
        h('p.page-head__sub', projects.length
          ? 'Pick up where you left off, or give DiroxCode something new to build.'
          : 'Connect your first project and DiroxCode will index it and get to work.')
      ),

      h('div.section', quickActions()),

      usage ? h('div.section', usageStrip(usage)) : null,

      h('section.section',
        h('div.section__head',
          h('h2.section__title', 'Projects'),
          projects.length ? h('a.btn.btn--ghost.btn--sm', { href: '/app/projects' }, 'All projects', icon('chevronRight', { size: 13 })) : null
        ),
        projects.length
          ? h('div.grid.grid--3', projects.map(projectCard))
          : h('div.card.empty',
              h('div.empty__title', 'No projects yet'),
              h('p.empty__body', 'Connect a GitHub repository or create an empty project. DiroxCode indexes it once and keeps the index current as things change.'),
              h('button.btn.btn--primary', { onClick: () => openNewProject() }, icon('plus', { size: 14 }), 'New project'))
      ),

      tasks.length
        ? h('section.section',
            h('div.section__head',
              h('h2.section__title', 'Recent tasks'),
              h('a.btn.btn--ghost.btn--sm', { href: '/app/tasks' }, 'All tasks', icon('chevronRight', { size: 13 }))
            ),
            h('div.stack--tight', { class: 'stack' }, tasks.map(taskRow))
          )
        : null
    );

    loadSidebarData();
  } catch (error) {
    toastError(error, 'Could not load your dashboard');
    mount(content,
      h('div.empty',
        h('h2.empty__title', 'Dashboard unavailable'),
        h('p.empty__body', error.message),
        h('button.btn', { onClick: () => render() }, 'Try again'))
    );
  }
}
