/**
 * Task detail: objective, timeline, changed files, cost and checkpoints.
 * A running task reconnects to its live stream so the page is never stale.
 */

import { h, icon, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { router } from '../lib/router.js';
import { renderInShell, setPanel } from '../components/shell.js';
import { createActivity } from '../components/activity.js';
import { renderMarkdown } from '../components/markdown.js';
import { confirmModal } from '../components/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { formatCost, formatDuration, formatTokens, relativeTime, formatDate } from '../lib/format.js';

let stream = null;

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

function metaCard(task) {
  const rows = [
    ['Model', task.result?.model || '—'],
    ['Mode', task.mode],
    ['Complexity', task.complexity ? task.complexity.replace('level', 'Level ') : '—'],
    ['Tokens', task.inputTokens || task.outputTokens ? formatTokens(task.inputTokens + task.outputTokens) : '—'],
    ['Cost', formatCost(task.costMicros)],
    ['Budget', formatCost(task.budgetMicros)],
    ['Duration', task.durationMs ? formatDuration(task.durationMs) : '—'],
    ['Steps', String(task.iterations || 0)],
    ['Started', task.startedAt ? formatDate(task.startedAt, { dateStyle: 'medium', timeStyle: 'short' }) : '—']
  ];

  return h('div.card',
    h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'This task'),
    h('dl.meta-list', rows.map(([label, value]) => h('div.meta-row',
      h('dt.meta-row__label', label),
      h('dd.meta-row__value', value)
    )))
  );
}

async function checkpointsCard(task, onRestore) {
  const body = h('div.stack--tight', { class: 'stack' }, h('div.skeleton', { style: { height: '40px' } }));
  const card = h('div.card',
    h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'Restore points'),
    body
  );

  try {
    const { checkpoints } = await api.get(`/tasks/${task.id}/checkpoints`);
    if (!checkpoints.length) {
      mount(body, h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'No restore point was created for this task.'));
      return card;
    }
    mount(body, checkpoints.map(checkpoint => h('div.row.row--between', { style: { gap: 'var(--s-2)' } },
      h('div', { style: { minWidth: '0' } },
        h('div.truncate', { style: { fontSize: 'var(--fs-xs)' } }, checkpoint.label || checkpoint.kind),
        h('div.subtle', { style: { fontSize: 'var(--fs-2xs)' } },
          `${checkpoint.fileCount} files · ${relativeTime(checkpoint.createdAt)}${checkpoint.restoredAt ? ' · restored' : ''}`)
      ),
      h('button.btn.btn--sm', { onClick: () => onRestore(checkpoint) }, 'Restore')
    )));
  } catch {
    mount(body, h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'Restore points are unavailable.'));
  }
  return card;
}

function changedFilesCard(task) {
  const files = task.changedFiles || [];
  if (!files.length) return null;

  return h('div.card',
    h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, `${files.length} file${files.length === 1 ? '' : 's'} changed`),
    h('div.tree', files.map(file => h('button.tree__row', {
      onClick: () => task.projectId && openFile(task.projectId, file.path)
    },
      icon('file', { size: 13 }),
      h('span.tree__name', file.path),
      h('span.tree__badge', {
        class: file.kind === 'created' ? 'tree__badge--add' : file.kind === 'deleted' ? 'tree__badge--del' : 'tree__badge--mod'
      }, file.kind === 'created' ? 'new' : file.kind === 'deleted' ? 'del' : 'mod')
    )))
  );
}

async function openFile(projectId, path) {
  setPanel({ tabs: [{ id: 'file', label: 'File', onSelect: () => {} }], active: 'file', body: h('div.skeleton', { style: { height: '200px', margin: 'var(--s-4)' } }) });
  try {
    const { file } = await api.get(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`);
    setPanel({
      tabs: [{ id: 'file', label: 'File', onSelect: () => {} }],
      active: 'file',
      body: h('div',
        h('div.panel__head', h('span.panel__title.mono.truncate', path)),
        h('div.code', { style: { border: 'none', borderRadius: '0' } }, h('pre', h('code', file.content)))
      )
    });
  } catch (error) {
    setPanel({ tabs: [{ id: 'file', label: 'File', onSelect: () => {} }], active: 'file', body: h('div.empty', h('p.empty__body', error.message)) });
  }
}

function findingsSection(findings) {
  if (!findings.length) return null;
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 5) - (order[b.severity] ?? 5));

  return h('section.section',
    h('div.section__head', h('h2.section__title', `Review findings (${findings.length})`)),
    h('div.panel', sorted.map(finding => h('div.finding', { 'data-severity': finding.severity },
      h('div.finding__sev'),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div.row', { style: { gap: 'var(--s-2)' } },
          h('span.badge', { class: ['critical', 'high'].includes(finding.severity) ? 'badge--danger' : finding.severity === 'medium' ? 'badge--warning' : '' }, finding.severity),
          h('span.finding__title', finding.title)
        ),
        finding.file_path ? h('div.finding__where', `${finding.file_path}${finding.line ? `:${finding.line}` : ''}`) : null,
        finding.detail ? h('div.finding__detail', finding.detail) : null,
        finding.suggestion ? h('div.finding__detail', h('strong', 'Fix: '), finding.suggestion) : null
      )
    )))
  );
}

export async function render({ params }) {
  stream?.close();
  stream = null;

  const content = h('div.view__inner');
  renderInShell(content, { title: 'Task', crumbs: [['Tasks', '/app/tasks'], ['…', null]] });
  mount(content, h('div.skeleton', { style: { height: '300px' } }));

  let data;
  try {
    data = await api.get(`/tasks/${params.id}`);
  } catch (error) {
    toastError(error, 'Task could not be opened');
    return mount(content, h('div.empty',
      h('h2.empty__title', 'Task unavailable'),
      h('p.empty__body', error.message),
      h('a.btn', { href: '/app/tasks' }, 'Back to tasks')));
  }

  const task = data.task;
  const [statusLabel, statusVariant] = STATUS[task.status] || [task.status, ''];
  renderInShell(content, { title: task.title, crumbs: [['Tasks', '/app/tasks'], [task.title.slice(0, 40), null]] });

  const activity = createActivity({ onFileClick: path => task.projectId && openFile(task.projectId, path) });
  for (const step of data.steps) activity.step(step);
  for (const call of data.toolCalls) {
    activity.tool({ id: call.id, name: call.tool, status: call.status, description: call.arguments?.path || call.arguments?.command || '' });
  }
  if (task.status === 'completed') activity.done({ summary: task.result?.summary, changedFiles: task.changedFiles, budget: { spentMicros: task.costMicros } });
  if (task.status === 'failed') activity.failed(task.error);

  const restore = checkpoint => confirmModal({
    title: 'Restore this point?',
    message: `Files will be returned to the state captured at "${checkpoint.label || checkpoint.kind}". Any change made since then is lost.`,
    confirmLabel: 'Restore',
    onConfirm: async () => {
      const result = await api.post(`/tasks/${task.id}/checkpoints/${checkpoint.id}/restore`, {});
      toast.success(`Restored ${result.restored.length} file${result.restored.length === 1 ? '' : 's'}.`);
      if (result.failed?.length) {
        toast.warning(`${result.failed.length} file${result.failed.length === 1 ? '' : 's'} could not be restored.`);
      }
    }
  });

  const actions = h('div.row',
    data.running
      ? h('button.btn.btn--danger', {
          onClick: async () => {
            try { await api.post(`/tasks/${task.id}/stop`, {}); toast('Stopping…'); }
            catch (error) { toastError(error); }
          }
        }, icon('stop', { size: 13 }), 'Stop')
      : h('button.btn', {
          onClick: async () => {
            try {
              const result = await api.post(`/tasks/${task.id}/retry`, {});
              router.navigate(`/app/tasks/${result.task.id}`);
            } catch (error) { toastError(error); }
          }
        }, icon('refresh', { size: 13 }), 'Run again'),
    task.projectId
      ? h('a.btn.btn--primary', { href: `/app/projects/${task.projectId}/chat${task.conversationId ? `/${task.conversationId}` : ''}` },
          icon('chat', { size: 13 }), 'Open in chat')
      : null
  );

  mount(content,
    h('div.page-head',
      h('div.page-head__row',
        h('div', { style: { minWidth: '0' } },
          h('div.row', { style: { gap: 'var(--s-2)', marginBottom: 'var(--s-3)' } },
            h('span.badge', { class: statusVariant }, data.running ? h('span.dot.dot--pulse') : null, statusLabel),
            h('span.badge', task.mode),
            task.projectName ? h('a.badge', { href: `/app/projects/${task.projectId}` }, icon('folder', { size: 11 }), task.projectName) : null
          ),
          h('h1.page-head__title', { style: { fontSize: 'var(--fs-2xl)' } }, task.title)
        ),
        actions
      )
    ),

    h('div.card', { style: { marginBottom: 'var(--s-6)' } },
      h('div.eyebrow', { style: { marginBottom: 'var(--s-2)' } }, 'Objective'),
      h('div', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', whiteSpace: 'pre-wrap' } }, task.objective)
    ),

    task.error ? h('div.card', { style: { borderColor: 'var(--accent-line)', marginBottom: 'var(--s-6)' } },
      h('div.eyebrow', { style: { color: 'var(--danger)', marginBottom: 'var(--s-2)' } }, 'Why it stopped'),
      h('p', { style: { fontSize: 'var(--fs-sm)', margin: '0' } }, task.error)) : null,

    h('div.split', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 280px', gap: 'var(--s-6)', alignItems: 'start' } },
      h('div',
        h('section.section',
          h('div.section__head', h('h2.section__title', 'Activity')),
          h('div.card', activity.element)
        ),

        task.result?.summary ? h('section.section',
          h('div.section__head', h('h2.section__title', 'Result')),
          h('div.card', renderMarkdown(task.result.summary, { onFileClick: path => task.projectId && openFile(task.projectId, path) }))
        ) : null,

        task.plan?.steps?.length ? h('section.section',
          h('div.section__head', h('h2.section__title', 'Plan')),
          h('div.card',
            task.plan.summary ? h('p.muted', { style: { fontSize: 'var(--fs-sm)' } }, task.plan.summary) : null,
            h('ol', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s-2)', counterReset: 'step' } },
              task.plan.steps.map((step, index) => h('li', { style: { fontSize: 'var(--fs-sm)' } },
                h('span.mono.subtle', `${index + 1}. `),
                step.title,
                step.files?.length ? h('span.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, ` — ${step.files.join(', ')}`) : null
              )))
          )
        ) : null,

        findingsSection(data.findings || [])
      ),

      h('div.stack',
        metaCard(task),
        changedFilesCard(task),
        h('div', { ref: node => checkpointsCard(task, restore).then(card => node.replaceWith(card)) })
      )
    )
  );

  // Reconnect to a live run so the page shows progress rather than a snapshot.
  if (data.running) {
    stream = api.stream(`/tasks/${task.id}/stream`, {
      onEvent: (type, payload) => {
        if (type === 'step') activity.step(payload);
        else if (type === 'tool') activity.tool(payload);
        else if (type === 'context') activity.context(payload);
        else if (type === 'notice') activity.notice(payload);
        else if (type === 'done') activity.done(payload);
        else if (type === 'error') activity.failed(payload.message);
        else if (type === 'finished') { stream?.close(); stream = null; render({ params }); }
      }
    });
  }

  return () => { stream?.close(); stream = null; };
}
