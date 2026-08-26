/**
 * The workspace: conversation, live agent activity, and the work panels.
 *
 * This is where the product lives. The interface stays quiet for a simple
 * question and reveals development panels only when the task involves code.
 */

import { h, icon, mount, clear, qs } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { renderInShell, setPanel } from '../components/shell.js';
import { registerCommands, clearCommands } from '../components/palette.js';
import { createComposer } from '../components/composer.js';
import { createActivity } from '../components/activity.js';
import { renderMarkdown, renderDiff } from '../components/markdown.js';
import { confirmModal } from '../components/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { formatCost, formatDuration, formatTokens, relativeTime } from '../lib/format.js';

let currentStream = null;
let currentTaskId = null;

function closeStream() {
  currentStream?.close();
  currentStream = null;
}

/** A user turn. */
function userMessage(text) {
  return h('div.msg.msg--user',
    h('div.msg__role', 'You'),
    h('div.msg__body', renderMarkdown(text))
  );
}

/** An assistant turn, with the activity timeline attached above the answer. */
function assistantMessage({ activityElement, onFileClick }) {
  const body = h('div.msg__body');
  const foot = h('div.msg__foot');
  const element = h('div.msg.msg--assistant',
    h('div.msg__role', icon('sparkle', { size: 12 }), 'DiroxCode'),
    activityElement,
    body,
    foot
  );
  return { element, body, foot };
}

function approvalCard({ approval, onDecide }) {
  const card = h('div.approval', { role: 'alertdialog' },
    h('div.approval__title', 'Approval needed'),
    h('div.approval__what', approval.description),
    h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--s-2)' } },
      `This is a ${approval.risk} action. It will not run until you approve it.`),
    h('div.approval__actions',
      h('button.btn.btn--primary.btn--sm', { onClick: () => onDecide(true) }, 'Approve and continue'),
      h('button.btn.btn--sm', { onClick: () => onDecide(false) }, 'Decline')
    )
  );
  return card;
}

async function openFilePanel(projectId, path, line) {
  setPanel({
    tabs: filePanelTabs(projectId),
    active: 'file',
    body: h('div.skeleton', { style: { height: '200px', margin: 'var(--s-4)' } })
  });

  try {
    const { file } = await api.get(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`);
    const language = path.split('.').pop();
    const lines = file.content.split('\n');

    setPanel({
      tabs: filePanelTabs(projectId),
      active: 'file',
      body: h('div',
        h('div.panel__head',
          h('span.panel__title.mono.truncate', path),
          h('span.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, `${lines.length} lines`)
        ),
        h('div.code', { style: { border: 'none', borderRadius: '0' } },
          h('pre', h('code', file.content))
        )
      )
    });

    if (line) {
      requestAnimationFrame(() => {
        const pre = qs('.workpanel__body pre');
        if (pre) pre.scrollTop = Math.max(0, (line - 6) * 19);
      });
    }
  } catch (error) {
    setPanel({
      tabs: filePanelTabs(projectId),
      active: 'file',
      body: h('div.empty', h('p.empty__body', error.message))
    });
  }
}

function filePanelTabs(projectId) {
  return [
    { id: 'file', label: 'File', onSelect: () => {} },
    { id: 'changes', label: 'Changes', onSelect: () => openChangesPanel(projectId) },
    { id: 'files', label: 'Files', onSelect: () => openTreePanel(projectId) }
  ];
}

async function openChangesPanel(projectId, changedFiles = []) {
  const body = h('div');
  setPanel({ tabs: filePanelTabs(projectId), active: 'changes', body });

  if (!changedFiles.length) {
    return mount(body, h('div.empty', { style: { padding: 'var(--s-8)' } },
      h('p.empty__body', 'No files have been changed in this session yet.')));
  }

  mount(body, h('div.tree', changedFiles.map(file => h('button.tree__row', {
    onClick: () => openFilePanel(projectId, file.path)
  },
    icon('file', { size: 13 }),
    h('span.tree__name', file.path),
    h('span.tree__badge', {
      class: file.kind === 'created' ? 'tree__badge--add' : file.kind === 'deleted' ? 'tree__badge--del' : 'tree__badge--mod'
    }, file.kind === 'created' ? 'new' : file.kind === 'deleted' ? 'del' : 'mod')
  ))));
}

async function openTreePanel(projectId) {
  const body = h('div.skeleton', { style: { height: '200px', margin: 'var(--s-4)' } });
  setPanel({ tabs: filePanelTabs(projectId), active: 'files', body });

  try {
    const { files } = await api.get(`/projects/${projectId}/files?limit=400`);
    const tree = h('div.tree', files.map(file => h('button.tree__row', {
      onClick: () => openFilePanel(projectId, file.path)
    }, icon('file', { size: 13 }), h('span.tree__name', file.path))));
    setPanel({ tabs: filePanelTabs(projectId), active: 'files', body: tree });
  } catch (error) {
    setPanel({ tabs: filePanelTabs(projectId), active: 'files', body: h('div.empty', h('p.empty__body', error.message)) });
  }
}

export async function render({ params, query = {} }) {
  closeStream();

  const projectId = params.id;
  const scroll = h('div.chat__scroll');
  const thread = h('div.chat__inner');
  scroll.appendChild(thread);

  const chat = h('div.chat', scroll);
  const view = h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: '0' } }, chat);

  renderInShell(view, { title: 'Chat', crumbs: [['Projects', '/app/projects'], ['…', null]] });
  // The workspace fills the viewport rather than scrolling the page.
  view.closest('.view')?.style.setProperty('overflow', 'hidden');

  let project;
  try {
    const data = await api.get(`/projects/${projectId}`);
    project = data.project;
    store.set({ project });
  } catch (error) {
    toastError(error, 'Project could not be opened');
    return router.navigate('/app/projects');
  }

  renderInShell(view, {
    title: project.name,
    crumbs: [['Projects', '/app/projects'], [project.name, `/app/projects/${projectId}`], ['Chat', null]]
  });
  view.closest('.view')?.style.setProperty('overflow', 'hidden');

  const onFileClick = (path, line) => openFilePanel(projectId, path, line);

  // ── conversation ──
  let conversation = null;
  if (params.conversationId) {
    try {
      const data = await api.get(`/conversations/${params.conversationId}`);
      conversation = data.conversation;
      for (const message of data.messages) {
        if (message.role === 'user') thread.appendChild(userMessage(message.content));
        else {
          const bubble = assistantMessage({ activityElement: h('div'), onFileClick });
          mount(bubble.body, renderMarkdown(message.content, { onFileClick }));
          if (message.costMicros) {
            mount(bubble.foot, h('span', formatCost(message.costMicros)), h('span', '·'), h('span', formatTokens(message.tokens)));
          }
          thread.appendChild(bubble.element);
        }
      }
    } catch (error) {
      toastError(error, 'Conversation could not be loaded');
    }
  }

  if (!thread.children.length) {
    thread.appendChild(h('div.empty', { style: { paddingTop: 'var(--s-16)' } },
      h('span', { style: { color: 'var(--accent)' } }, icon('sparkle', { size: 26 })),
      h('div.empty__title', `Ask DiroxCode about ${project.name}`),
      h('p.empty__body',
        project.indexStatus === 'ready'
          ? `${project.fileCount} files indexed. Describe what you want built, fixed or explained.`
          : 'This project is still being indexed — you can ask questions, but retrieval will improve once it finishes.'),
      h('div.row.row--wrap', { style: { justifyContent: 'center', marginTop: 'var(--s-4)' } },
        ['Explain this codebase', 'Find and fix the failing test', 'Review my latest changes', 'Add authentication']
          .map(suggestion => h('button.btn.btn--sm', {
            onClick: () => { composer.setValue(suggestion); composer.focus(); }
          }, suggestion)))
    ));
  }

  // ── composer ──
  const composer = createComposer({
    mode: query.mode || conversation?.mode || 'agent',
    placeholder: `Tell DiroxCode what you want to build in ${project.name}…`,
    onSend: (text, options) => runTask(text, options),
    onStop: () => stopCurrent()
  });
  view.appendChild(composer.element);

  registerCommands('workspace', [
    { id: 'files', group: 'Workspace', label: 'Show project files', icon: 'file', run: () => openTreePanel(projectId) },
    { id: 'changes', group: 'Workspace', label: 'Show changed files', icon: 'layers', run: () => openChangesPanel(projectId, lastChangedFiles) },
    { id: 'project', group: 'Workspace', label: 'Open project overview', icon: 'projects', run: () => router.navigate(`/app/projects/${projectId}`) },
    { id: 'stop', group: 'Workspace', label: 'Stop the agent', icon: 'stop', hint: 'Esc', run: () => stopCurrent() }
  ]);

  let lastChangedFiles = [];

  function scrollToEnd() {
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  async function stopCurrent() {
    if (!currentTaskId) return;
    try {
      await api.post(`/tasks/${currentTaskId}/stop`, {});
      toast('Stopping the agent…');
    } catch (error) { toastError(error); }
  }

  async function runTask(text, { mode, attachments }) {
    // The empty state is replaced by the first real turn.
    const empty = thread.querySelector('.empty');
    if (empty) empty.remove();

    // Attachments are appended to the objective as labelled context.
    let objective = text;
    for (const attachment of attachments || []) {
      if (attachment.type === 'text') {
        objective += `\n\nAttached file "${attachment.name}":\n\`\`\`\n${String(attachment.content).slice(0, 20_000)}\n\`\`\``;
      } else {
        objective += `\n\n(An image "${attachment.name}" was attached. Images are not yet passed to the model — describe what it shows if it matters.)`;
      }
    }

    thread.appendChild(userMessage(text));
    scrollToEnd();

    const activity = createActivity({ onFileClick });
    const bubble = assistantMessage({ activityElement: activity.element, onFileClick });
    thread.appendChild(bubble.element);
    scrollToEnd();

    composer.setRunning(true);

    // Conversation is created lazily, so a one-off question costs no row.
    if (!conversation) {
      try {
        const created = await api.post('/conversations', { projectId, mode });
        conversation = created.conversation;
        history.replaceState({}, '', `/app/projects/${projectId}/chat/${conversation.id}`);
      } catch { /* the task still runs without a conversation record */ }
    }
    if (conversation) {
      api.post(`/conversations/${conversation.id}/messages`, { role: 'user', content: text }).catch(() => {});
    }

    let task;
    try {
      const created = await api.post('/tasks', {
        objective,
        projectId,
        conversationId: conversation?.id,
        mode,
        background: mode === 'autopilot'
      });
      task = created.task;
      currentTaskId = task.id;
    } catch (error) {
      composer.setRunning(false);
      activity.failed(error.message);
      mount(bubble.body, h('p.field__error', error.message));
      return;
    }

    if (task.status === 'queued' && !currentTaskId) return;

    // ── follow the run ──
    let finalText = '';
    let budget = null;
    let approvalShown = false;

    currentStream = api.stream(`/tasks/${task.id}/stream`, {
      onEvent: (type, data) => {
        switch (type) {
          case 'step': activity.step(data); break;
          case 'tool': activity.tool(data); break;
          case 'context': activity.context(data); break;
          case 'model': activity.model(data); break;
          case 'notice': activity.notice(data); break;
          case 'cost': budget = data; break;
          case 'plan':
            if (data.summary) mount(bubble.body, renderMarkdown(`**Plan.** ${data.summary}`, { onFileClick }));
            break;
          case 'approval':
            if (approvalShown) break;
            approvalShown = true;
            bubble.element.appendChild(approvalCard({
              approval: data,
              onDecide: async approved => {
                try {
                  const result = await api.post(`/tasks/${task.id}/approve`, { approved, toolCallId: data.toolCallId });
                  bubble.element.querySelector('.approval')?.remove();
                  if (result.resumed) {
                    approvalShown = false;
                    composer.setRunning(true);
                    followStream(task.id);
                  } else {
                    composer.setRunning(false);
                    activity.failed('You declined the action.');
                  }
                } catch (error) { toastError(error); }
              }
            }));
            scrollToEnd();
            break;
          case 'done':
            finalText = data.summary || '';
            lastChangedFiles = data.changedFiles || [];
            activity.done({ ...data, budget });
            break;
          case 'error':
            activity.failed(data.message);
            mount(bubble.body, h('p.field__error', data.message));
            break;
          case 'cancelled':
            activity.failed('Stopped.');
            break;
          case 'state':
            if (data.result?.summary) finalText = data.result.summary;
            lastChangedFiles = data.changedFiles || [];
            break;
          case 'finished':
            finishRun();
            break;
          default: break;
        }
        scrollToEnd();
      },
      onError: error => {
        composer.setRunning(false);
        activity.failed(error.message || 'The activity stream was interrupted');
      }
    });

    function followStream(id) {
      closeStream();
      currentStream = api.stream(`/tasks/${id}/stream`, { onEvent: () => {} });
    }

    function finishRun() {
      composer.setRunning(false);
      currentTaskId = null;
      closeStream();

      if (finalText) {
        mount(bubble.body, renderMarkdown(finalText, { onFileClick }));
        if (conversation) {
          api.post(`/conversations/${conversation.id}/messages`, {
            role: 'assistant', content: finalText, taskId: task.id
          }).catch(() => {});
        }
      }

      const footParts = [];
      if (budget?.spentMicros) footParts.push(h('span', formatCost(budget.spentMicros)));
      if (lastChangedFiles.length) {
        footParts.push(h('button.btn.btn--ghost.btn--sm', {
          style: { padding: '0', height: 'auto', fontSize: 'var(--fs-2xs)' },
          onClick: () => openChangesPanel(projectId, lastChangedFiles)
        }, `${lastChangedFiles.length} file${lastChangedFiles.length === 1 ? '' : 's'} changed`));
      }
      footParts.push(h('a', { href: `/app/tasks/${task.id}`, style: { fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)' } }, 'Task details'));
      mount(bubble.foot, footParts.flatMap((part, index) => index ? [h('span', '·'), part] : [part]));

      if (lastChangedFiles.length) openChangesPanel(projectId, lastChangedFiles);
      scrollToEnd();
    }
  }

  composer.focus();
  scrollToEnd();

  return () => { closeStream(); clearCommands('workspace'); };
}
