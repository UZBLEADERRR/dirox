/**
 * Project home.
 *
 * Health, repository state, recent tasks and memory — with one obvious primary
 * action: ask DiroxCode. Indexing status polls only while indexing is running.
 */

import { h, icon, mount, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { renderInShell, setPanel, clearPanel } from '../components/shell.js';
import { registerCommands } from '../components/palette.js';
import { confirmModal, openModal } from '../components/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { formatBytes, formatCost, pluralize, relativeTime } from '../lib/format.js';

let pollTimer = null;

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function statusBanner(project, onReindex) {
  if (project.indexStatus === 'running') {
    return h('div.task-strip',
      h('span.dot.dot--pulse'),
      h('span.task-strip__label', 'Indexing this project'),
      h('span.subtle', 'Reading files, extracting symbols and building the import graph.')
    );
  }
  if (project.indexStatus === 'failed') {
    return h('div.task-strip', { style: { borderColor: 'var(--accent-line)' } },
      h('span.dot.dot--danger'),
      h('span.task-strip__label', 'Indexing failed'),
      h('span.subtle.truncate', project.indexError || 'The index could not be built.'),
      h('button.btn.btn--sm', { style: { marginLeft: 'auto' }, onClick: onReindex }, 'Retry')
    );
  }
  if (project.indexStatus === 'stale') {
    return h('div.task-strip',
      h('span.dot.dot--warning'),
      h('span.task-strip__label', 'Partially indexed'),
      h('span.subtle.truncate', project.indexError || 'Not every file could be indexed.'),
      h('button.btn.btn--sm', { style: { marginLeft: 'auto' }, onClick: onReindex }, 'Re-index')
    );
  }
  if (project.indexStatus === 'pending') {
    return h('div.task-strip',
      h('span.dot'),
      h('span.task-strip__label', 'Not indexed yet'),
      h('button.btn.btn--sm', { style: { marginLeft: 'auto' }, onClick: onReindex }, 'Index now')
    );
  }
  return null;
}

function healthGrid(project) {
  const tiles = [
    ['Files', project.fileCount ? String(project.fileCount) : '—'],
    ['Symbols', project.symbolCount ? String(project.symbolCount) : '—'],
    ['Size', project.sizeBytes ? formatBytes(project.sizeBytes) : '—'],
    ['Indexed', project.indexedAt ? relativeTime(project.indexedAt) : 'never']
  ];
  return h('div.grid.grid--4', tiles.map(([label, value]) => h('div.stat',
    h('div.stat__label', label),
    h('div.stat__value', { style: { fontSize: 'var(--fs-xl)' } }, value)
  )));
}

function commandsPanel(project, onSave) {
  const fields = [
    ['testCommand', 'Test command', 'npm test'],
    ['buildCommand', 'Build command', 'npm run build'],
    ['devCommand', 'Dev command', 'npm run dev'],
    // Whatever this team actually runs to ship. The agent asks before running
    // it, every time, because its consequence is other people.
    ['deployCommand', 'Deploy command', 'git push production main']
  ];

  const inputs = {};
  const body = h('div.stack',
    h('p.field__hint', 'Detected from your project files. Correct them if DiroxCode guessed wrong — the agent runs exactly these.'),
    fields.map(([key, label, placeholder]) => {
      inputs[key] = h('input.input', { value: project[key] || '', placeholder, maxlength: '200' });
      return h('div.field', h('label.label', label), inputs[key]);
    })
  );

  const save = h('button.btn.btn--primary', {
    onClick: async () => {
      save.disabled = true;
      try {
        await onSave(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])));
        toast.success('Commands updated.');
        modal.close();
      } catch (error) {
        toastError(error);
        save.disabled = false;
      }
    }
  }, 'Save');

  const modal = openModal({ title: 'Project commands', body, actions: [h('button.btn', { onClick: () => modal.close() }, 'Cancel'), save] });
  return modal;
}

function memoryPanel(projectId) {
  const list = h('div.stack--tight', { class: 'stack' });

  const load = async () => {
    mount(list, h('div.skeleton', { style: { height: '48px' } }));
    try {
      const { memory } = await api.get(`/projects/${projectId}/memory`);
      if (!memory.length) {
        return mount(list, h('div.empty', { style: { padding: 'var(--s-6)' } },
          h('p.empty__body', 'Nothing remembered yet. DiroxCode records architecture decisions, conventions and fixes as it works — and you can add rules yourself.')));
      }
      mount(list, memory.map(entry => h('div.card', { style: { padding: 'var(--s-3) var(--s-4)' } },
        h('div.row.row--between',
          h('span.badge', entry.kind),
          h('button.btn.btn--ghost.btn--icon.btn--sm', {
            'aria-label': 'Forget this',
            onClick: async () => {
              await api.delete(`/projects/${projectId}/memory/${entry.id}`).catch(toastError);
              load();
            }
          }, icon('close', { size: 12 }))
        ),
        h('p', { style: { fontSize: 'var(--fs-sm)', margin: 'var(--s-2) 0 0' } }, entry.content),
        h('div.subtle', { style: { fontSize: 'var(--fs-2xs)', marginTop: 'var(--s-2)' } },
          `${entry.source} · ${relativeTime(entry.created_at)}`)
      )));
    } catch (error) {
      mount(list, h('div.empty', h('p.empty__body', error.message)));
    }
  };

  const input = h('textarea.textarea', { rows: '2', placeholder: 'Always use the repository pattern for database access.', maxlength: '2000' });
  const add = h('button.btn.btn--sm', {
    onClick: async () => {
      const content = input.value.trim();
      if (!content) return;
      add.disabled = true;
      try {
        await api.post(`/projects/${projectId}/memory`, { kind: 'rule', content });
        input.value = '';
        load();
      } catch (error) { toastError(error); }
      finally { add.disabled = false; }
    }
  }, 'Remember this');

  load();
  return h('div', { style: { padding: 'var(--s-4)' } },
    h('div.field', { style: { marginBottom: 'var(--s-4)' } }, input, h('div.row', { style: { justifyContent: 'flex-end' } }, add)),
    list
  );
}

async function filesPanel(projectId) {
  const body = h('div');
  try {
    const { files, indexed } = await api.get(`/projects/${projectId}/files?limit=300`);
    if (!files.length) {
      mount(body, h('div.empty', h('p.empty__body', 'No files indexed yet.')));
    } else {
      mount(body, h('div.tree',
        !indexed ? h('p.field__hint', { style: { padding: 'var(--s-2)' } }, 'Showing the live workspace — the index has not finished.') : null,
        files.map(file => h('a.tree__row', {
          href: `/app/projects/${projectId}?file=${encodeURIComponent(file.path)}`
        },
          icon('file', { size: 13 }),
          h('span.tree__name', file.path)
        ))
      ));
    }
  } catch (error) {
    mount(body, h('div.empty', h('p.empty__body', error.message)));
  }
  return body;
}

export async function render({ params, query = {} }) {
  stopPolling();
  const content = h('div.view__inner');
  renderInShell(content, { title: 'Project', crumbs: [['Projects', '/app/projects'], ['…', null]] });
  mount(content, h('div.skeleton', { style: { height: '220px' } }));

  let data;
  try {
    data = await api.get(`/projects/${params.id}`);
  } catch (error) {
    toastError(error, 'Project could not be opened');
    return mount(content, h('div.empty',
      h('h2.empty__title', 'Project unavailable'),
      h('p.empty__body', error.message),
      h('a.btn', { href: '/app/projects' }, 'Back to projects')
    ));
  }

  const project = data.project;
  store.set({ project });
  renderInShell(content, { title: project.name, crumbs: [['Projects', '/app/projects'], [project.name, null]] });

  const reindex = async (full = false) => {
    try {
      await api.post(`/projects/${project.id}/index`, { full });
      toast('Indexing started.');
      poll();
    } catch (error) { toastError(error, 'Indexing could not be started'); }
  };

  const syncRepo = async () => {
    try {
      await api.post(`/github/projects/${project.id}/sync`, {});
      toast('Pulling the latest commit.');
      poll();
    } catch (error) { toastError(error, 'Sync failed'); }
  };

  function poll() {
    stopPolling();
    pollTimer = setTimeout(async () => {
      try {
        const fresh = await api.get(`/projects/${project.id}`);
        if (fresh.project.indexStatus !== project.indexStatus || fresh.project.fileCount !== project.fileCount) {
          return render({ params, query });
        }
        if (fresh.project.indexStatus === 'running') poll();
      } catch { /* stop polling on error */ }
    }, 4000);
  }

  registerCommands('project', [
    { id: 'ask', group: 'Project', label: 'Ask DiroxCode', icon: 'sparkle', run: () => router.navigate(`/app/projects/${project.id}/chat`) },
    { id: 'reindex', group: 'Project', label: 'Re-index project', icon: 'refresh', run: () => reindex(false) },
    { id: 'reindex-full', group: 'Project', label: 'Rebuild index from scratch', icon: 'refresh', run: () => reindex(true) },
    { id: 'files', group: 'Project', label: 'Show files', icon: 'file', run: () => showPanel('files') },
    { id: 'memory', group: 'Project', label: 'Show project memory', icon: 'layers', run: () => showPanel('memory') },
    project.repository ? { id: 'sync', group: 'Project', label: 'Pull latest from GitHub', icon: 'git', run: syncRepo } : null
  ].filter(Boolean));

  async function showPanel(tab) {
    const tabs = [
      { id: 'files', label: 'Files', onSelect: showPanel },
      { id: 'memory', label: 'Memory', onSelect: showPanel }
    ];
    setPanel({ tabs, active: tab, body: h('div.skeleton', { style: { height: '200px', margin: 'var(--s-4)' } }) });
    const body = tab === 'files' ? await filesPanel(project.id) : memoryPanel(project.id);
    setPanel({ tabs, active: tab, body });
  }

  if (query.file) showPanel('files');

  mount(content,
    h('div.page-head',
      h('div.page-head__row',
        h('div', { style: { minWidth: '0' } },
          h('h1.page-head__title', project.name),
          h('p.page-head__sub', project.description || 'No description yet.'),
          h('div.row.row--wrap', { style: { marginTop: 'var(--s-4)', gap: 'var(--s-2)' } },
            project.framework ? h('span.badge', project.framework) : null,
            project.language ? h('span.badge', project.language) : null,
            project.packageManager ? h('span.badge', project.packageManager) : null,
            project.repository
              ? h('a.badge', { href: project.repository.htmlUrl, target: '_blank', rel: 'noopener noreferrer' },
                  icon('git', { size: 11 }), project.repository.fullName, ' · ', project.repository.defaultBranch)
              : null
          )
        ),
        h('div.row',
          h('a.btn.btn--primary', { href: `/app/projects/${project.id}/chat` }, icon('sparkle', { size: 14 }), 'Ask DiroxCode'),
          h('button.btn.btn--icon', { 'aria-label': 'Project files', onClick: () => showPanel('files') }, icon('file', { size: 15 }))
        )
      )
    ),

    statusBanner(project, () => reindex(false)),

    h('div.section', { style: { marginTop: 'var(--s-6)' } }, healthGrid(project)),

    project.repository ? h('section.section',
      h('div.section__head', h('h2.section__title', 'Repository')),
      h('div.card',
        h('div.row.row--between',
          h('div',
            h('div.row', icon('git', { size: 15 }), h('span', { style: { fontWeight: '500' } }, project.repository.fullName)),
            h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--s-2)' } },
              project.repository.lastSyncedAt
                ? `Last pulled ${relativeTime(project.repository.lastSyncedAt)} from ${project.repository.defaultBranch}`
                : 'Not yet synchronised')
          ),
          h('button.btn.btn--sm', { onClick: syncRepo }, icon('refresh', { size: 13 }), 'Pull latest')
        ),
        project.repository.syncError
          ? h('p.field__error', { style: { marginTop: 'var(--s-3)' } }, project.repository.syncError)
          : null
      )
    ) : null,

    h('section.section',
      h('div.section__head',
        h('h2.section__title', 'Recent tasks'),
        h('a.btn.btn--ghost.btn--sm', { href: '/app/tasks' }, 'All tasks')
      ),
      data.recentTasks.length
        ? h('div.stack--tight', { class: 'stack' }, data.recentTasks.map(task =>
            h('a.card.card--interactive', { href: `/app/tasks/${task.id}`, style: { display: 'flex', gap: 'var(--s-3)', alignItems: 'center', padding: 'var(--s-3) var(--s-4)' } },
              h('span.dot', { class: task.status === 'completed' ? 'dot--success' : task.status === 'failed' ? 'dot--danger' : '' }),
              h('span.truncate', { style: { flex: '1', fontSize: 'var(--fs-sm)' } }, task.title),
              task.costMicros ? h('span.mono.subtle', formatCost(task.costMicros)) : null,
              h('span.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, relativeTime(task.createdAt))
            )))
        : h('div.card.empty',
            h('p.empty__body', 'No tasks yet. Ask DiroxCode to build, fix or explain something.'),
            h('a.btn.btn--primary', { href: `/app/projects/${project.id}/chat` }, 'Ask DiroxCode'))
    ),

    h('section.section',
      h('div.section__head', h('h2.section__title', 'Settings')),
      h('div.card.stack',
        h('div.row.row--between',
          h('div',
            h('div', { style: { fontSize: 'var(--fs-sm)', fontWeight: '500' } }, 'Commands'),
            h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: '2px' } },
              [project.testCommand && `test: ${project.testCommand}`, project.buildCommand && `build: ${project.buildCommand}`]
                .filter(Boolean).join(' · ') || 'Not detected')
          ),
          h('button.btn.btn--sm', {
            onClick: () => commandsPanel(project, async patch => {
              const { project: updated } = await api.patch(`/projects/${project.id}`, patch);
              store.set({ project: updated });
              render({ params, query });
            })
          }, 'Edit')
        ),
        h('div.divider'),
        h('div.row.row--between',
          h('div',
            h('div', { style: { fontSize: 'var(--fs-sm)', fontWeight: '500' } }, 'Re-index'),
            h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: '2px' } },
              'Incremental by default — unchanged files are skipped.')
          ),
          h('div.row',
            h('button.btn.btn--sm', { onClick: () => reindex(false) }, 'Re-index'),
            h('button.btn.btn--sm', { onClick: () => reindex(true) }, 'Rebuild')
          )
        ),
        h('div.divider'),
        h('div.row.row--between',
          h('div',
            h('div', { style: { fontSize: 'var(--fs-sm)', fontWeight: '500', color: 'var(--danger)' } }, 'Delete project'),
            h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: '2px' } },
              'Removes the index, tasks, checkpoints and workspace. Your GitHub repository is untouched.')
          ),
          h('button.btn.btn--danger.btn--sm', {
            onClick: () => confirmModal({
              title: 'Delete this project?',
              message: `Everything DiroxCode knows about ${project.name} will be removed. This cannot be undone.`,
              confirmLabel: 'Delete project',
              requirePhrase: project.name,
              onConfirm: async () => {
                await api.delete(`/projects/${project.id}`);
                toast.success('Project deleted.');
                clearPanel();
                router.navigate('/app/projects');
              }
            })
          }, 'Delete')
        )
      )
    )
  );

  if (project.indexStatus === 'running') poll();
}
