/** Project list: search, status, and the entry point to create or import one. */

import { h, icon, mount, debounce } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { renderInShell, loadSidebarData } from '../components/shell.js';
import { openNewProject } from '../components/new-project.js';
import { registerCommands } from '../components/palette.js';
import { formatBytes, pluralize, relativeTime } from '../lib/format.js';
import { toast, toastError } from '../lib/toast.js';

const INDEX_LABEL = {
  pending: ['Waiting to index', ''],
  running: ['Indexing…', 'pulse'],
  ready: ['Indexed', 'success'],
  stale: ['Partially indexed', 'warning'],
  failed: ['Index failed', 'danger']
};

function projectCard(project) {
  const [label, variant] = INDEX_LABEL[project.indexStatus] || ['Unknown', ''];

  return h('a.card.card--interactive', { href: `/app/projects/${project.id}`, style: { display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' } },
    h('div.row.row--between',
      h('div.row', { style: { minWidth: '0' } },
        icon('folder', { size: 16 }),
        h('span.truncate', { style: { fontWeight: '600', color: 'var(--text-strong)' } }, project.name)
      ),
      h('span.badge', { class: variant === 'success' ? 'badge--success' : variant === 'danger' ? 'badge--danger' : variant === 'warning' ? 'badge--warning' : '' },
        variant === 'pulse' ? h('span.dot.dot--pulse') : null, label)
    ),

    project.description
      ? h('p.clamp-2.muted', { style: { fontSize: 'var(--fs-sm)', margin: '0' } }, project.description)
      : h('p.subtle', { style: { fontSize: 'var(--fs-sm)', margin: '0' } }, 'No description yet.'),

    h('div.row.row--wrap', { style: { gap: 'var(--s-2)' } },
      project.framework ? h('span.badge', project.framework) : null,
      project.language ? h('span.badge', project.language) : null,
      project.repository ? h('span.badge', icon('git', { size: 11 }), project.repository.fullName) : null
    ),

    h('div.row', { style: { fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)', gap: 'var(--s-3)' } },
      project.fileCount ? h('span', pluralize(project.fileCount, 'file')) : null,
      project.symbolCount ? h('span', pluralize(project.symbolCount, 'symbol')) : null,
      project.sizeBytes ? h('span', formatBytes(project.sizeBytes)) : null,
      h('span', { style: { marginLeft: 'auto' } }, relativeTime(project.updatedAt))
    )
  );
}

export async function render({ query = {} } = {}) {
  const content = h('div.view__inner');
  renderInShell(content, { title: 'Projects', crumbs: [['Projects', null]] });

  const grid = h('div.grid.grid--3');
  const search = h('input.input', {
    type: 'search', placeholder: 'Search projects…', 'aria-label': 'Search projects',
    style: { maxWidth: '280px' }
  });

  mount(content,
    h('div.page-head',
      h('div.page-head__row',
        h('div',
          h('h1.page-head__title', 'Projects'),
          h('p.page-head__sub', 'Everything DiroxCode can work on in this organization.')
        ),
        h('div.row',
          search,
          h('button.btn.btn--primary', { onClick: () => openNewProject() }, icon('plus', { size: 14 }), 'New project')
        )
      )
    ),
    grid
  );

  registerCommands('projects', [
    { id: 'new-project-empty', group: 'Create', label: 'New empty project', icon: 'plus', run: () => openNewProject() },
    { id: 'new-project-github', group: 'Create', label: 'Import from GitHub', icon: 'git', run: () => openNewProject({ source: 'github' }) }
  ]);

  // The OAuth callback returns here with a status flag.
  if (query.github === 'connected') {
    toast.success('GitHub connected. Choose a repository to import.');
    openNewProject({ source: 'github' });
    history.replaceState({}, '', '/app/projects');
  } else if (query.github === 'failed') {
    toast.error('GitHub authorization did not complete. Please try again.');
    history.replaceState({}, '', '/app/projects');
  } else if (query.new) {
    openNewProject();
    history.replaceState({}, '', '/app/projects');
  }

  async function load(term = '') {
    mount(grid, h('div.skeleton', { style: { height: '160px' } }), h('div.skeleton', { style: { height: '160px' } }), h('div.skeleton', { style: { height: '160px' } }));
    try {
      const { projects } = await api.get(`/projects?limit=60${term ? `&q=${encodeURIComponent(term)}` : ''}`);
      store.set({ projects });

      if (!projects.length) {
        return mount(grid, h('div.card.empty', { style: { gridColumn: '1 / -1' } },
          h('span', { style: { color: 'var(--accent)' } }, icon('projects', { size: 24 })),
          h('div.empty__title', term ? 'No matching project' : 'No projects yet'),
          h('p.empty__body', term
            ? 'Try a different search term.'
            : 'Import a GitHub repository or start an empty project. DiroxCode indexes it once and keeps that index current.'),
          term ? null : h('div.row',
            h('button.btn.btn--primary', { onClick: () => openNewProject() }, 'New project'),
            h('button.btn', { onClick: () => openNewProject({ source: 'github' }) }, icon('git', { size: 14 }), 'Import from GitHub')
          )
        ));
      }

      mount(grid, projects.map(projectCard));
    } catch (error) {
      toastError(error, 'Projects could not be loaded');
      mount(grid, h('div.empty', { style: { gridColumn: '1 / -1' } }, h('p.empty__body', error.message)));
    }
  }

  search.addEventListener('input', debounce(() => load(search.value.trim()), 240));
  await load();
  loadSidebarData();
}
