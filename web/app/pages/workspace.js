/**
 * The chat: conversation, live agent activity, and the work panels.
 *
 * This is the product, and it is what you land on after signing in. A project
 * is optional — without one you can still ask DiroxCode anything, and the
 * composer offers a project when you want it to touch real code. The file and
 * change panels appear only once there is a repository to show.
 *
 * The interface stays quiet for a simple question and reveals development
 * panels only when the task involves code.
 */

import { h, icon, mount, qs } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { renderInShell, setPanel, clearPanel, refreshConversations } from '../components/shell.js';
import { registerCommands, clearCommands } from '../components/palette.js';
import { createComposer } from '../components/composer.js';
import { createActivity } from '../components/activity.js';
import { renderMarkdown } from '../components/markdown.js';
import { toast, toastError } from '../lib/toast.js';
import { formatCost, formatTokens } from '../lib/format.js';

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

/**
 * A file the agent produced and is handing over.
 *
 * A real anchor with `download`, not a scripted save: the browser then shows
 * its own progress, resumes, and puts the file where the person expects it.
 */
function deliverableCard(file) {
  return h('a.deliverable', {
    href: `/api/deliverables/${file.id}/download`,
    download: file.name,
    'data-native': 'true',
    title: `Download ${file.name}`,
    // A download URL cannot carry an Authorization header, so the grant is
    // fetched at the moment of the click and spent immediately. Navigating to
    // an attachment does not leave the page, so the conversation stays put.
    onClick: async event => {
      event.preventDefault();
      try {
        const { url } = await api.get(`/deliverables/${file.id}/link`);
        window.location.href = url;
      } catch (error) {
        toastError(error, 'That file could not be downloaded');
      }
    }
  },
    h('span.deliverable__icon', icon('file', { size: 16 })),
    h('span.deliverable__text',
      h('span.deliverable__name.truncate', file.name),
      h('span.deliverable__meta', [file.size || formatBytes(file.sizeBytes), file.label].filter(Boolean).join(' · '))
    ),
    h('span.deliverable__action', icon('arrowRight', { size: 15 }))
  );
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
    { id: 'files', label: 'Files', onSelect: () => openTreePanel(projectId) },
    { id: 'preview', label: 'Preview', onSelect: () => openPreviewPanel(projectId) }
  ];
}

/**
 * The app, running.
 *
 * The dev server has always run inside the container on loopback, where the
 * agent could reach it and nobody else could — so "build me a landing page"
 * ended with a description of a landing page. The server proxies it now, and
 * this is the window.
 *
 * The frame is sandboxed without `allow-same-origin`: it is the user's own
 * code on our origin, and it must not be able to read anything of ours.
 */
async function openPreviewPanel(projectId) {
  const body = h('div.preview');
  setPanel({ tabs: filePanelTabs(projectId), active: 'preview', body });

  const render = state => {
    if (state?.status === 'ready') {
      const frame = h('iframe.preview__frame', {
        src: `/api/projects/${projectId}/preview/`,
        title: 'Application preview',
        sandbox: 'allow-scripts allow-forms allow-popups allow-modals',
        loading: 'lazy'
      });

      return mount(body,
        h('div.preview__bar',
          h('span.preview__dot'),
          h('span.preview__label', 'Running'),
          h('div', { style: { flex: '1' } }),
          h('button.btn.btn--ghost.btn--sm', {
            title: 'Reload the preview',
            onClick: () => { frame.src = frame.src; }
          }, icon('refresh', { size: 13 })),
          h('button.btn.btn--ghost.btn--sm', {
            onClick: async () => {
              await api.post(`/projects/${projectId}/preview/stop`, {}).catch(() => {});
              load();
            }
          }, 'Stop')),
        frame);
    }

    const start = h('button.btn.btn--primary', {
      onClick: async () => {
        start.disabled = true;
        mount(body, h('div.empty', { style: { padding: 'var(--s-8)' } },
          h('p.empty__body', 'Starting the dev server…')));
        try {
          await api.post(`/projects/${projectId}/preview/start`, {});
          load();
        } catch (error) {
          toastError(error, 'The preview could not start');
          load();
        }
      }
    }, 'Start the preview');

    mount(body, h('div.empty', { style: { padding: 'var(--s-8)' } },
      h('div.empty__title', 'Nothing is running'),
      h('p.empty__body', state?.devCommand
        ? `This project starts with \`${state.devCommand}\`. Start it to see the app here.`
        : 'This project has no dev command yet. Ask DiroxCode to work out how it starts, or set one in project settings.'),
      state?.devCommand ? start : null));
  };

  async function load() {
    try {
      const { preview } = await api.get(`/projects/${projectId}/preview/status`);
      render(preview);
    } catch (error) {
      mount(body, h('div.empty', h('p.empty__body', error.message)));
    }
  }

  await load();
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

  // A project is optional. `/app` is a chat with none; a project route binds
  // the chat to that repository and turns on the file panels.
  let projectId = params.id || null;
  const scroll = h('div.chat__scroll');
  const thread = h('div.chat__inner');
  scroll.appendChild(thread);

  const view = h('div.chat', scroll);

  renderInShell(view, { title: 'Chat', fill: true });
  clearPanel();

  let project = null;
  if (projectId) {
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
      crumbs: [[project.name, `/app/projects/${projectId}`], ['Chat', null]],
      fill: true
    });
  } else {
    store.set({ project: null });
  }

  // Without a repository there is no file to open, so a citation is inert.
  const onFileClick = (path, line) => { if (projectId) openFilePanel(projectId, path, line); };

  /*
     Seed the work panel, closed.

     Its tabs used to appear only once the agent cited a file, which meant
     Preview was undiscoverable until something else happened to open the
     panel first. The tabs exist from the moment a project chat does.
  */
  if (projectId) {
    setPanel({
      tabs: filePanelTabs(projectId),
      active: 'files',
      body: h('div.empty', { style: { padding: 'var(--s-8)' } },
        h('p.empty__body', 'Files, changes and a live preview of the app appear here.')),
      open: false
    });
  }

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

    // A conversation bound to a project belongs on that project's route,
    // where the file panels work.
    if (!projectId && conversation?.projectId) {
      return router.navigate(`/app/projects/${conversation.projectId}/chat/${conversation.id}`, { replace: true });
    }
  }

  if (!thread.children.length) thread.appendChild(welcome());

  /** What you see before you have said anything. */
  function welcome() {
    const suggestions = project
      ? ['Explain this codebase', 'Find and fix the failing test', 'Review my latest changes', 'Add authentication']
      : ['Explain a piece of code I paste', 'Help me plan a feature', 'Review this error message', 'Connect a project'];

    return h('div.chat__welcome',
      h('span.chat__welcome-mark', icon('sparkle', { size: 24 })),
      h('h1.chat__welcome-title', project ? project.name : 'What can I help you build?'),
      h('p.chat__welcome-body',
        project
          ? (project.indexStatus === 'ready'
              ? `${project.fileCount} files indexed. Describe what you want built, fixed or explained.`
              : 'This project is still being indexed — ask away, and retrieval will improve once it finishes.')
          : 'Ask anything. Choose a project below when you want DiroxCode to read or change real code.'),
      h('div.chat__suggestions', suggestions.map(suggestion => h('button.btn.btn--sm', {
        onClick: () => {
          if (suggestion === 'Connect a project') return router.navigate('/app/projects');
          composer.setValue(suggestion);
          composer.focus();
        }
      }, suggestion)))
    );
  }

  // ── composer ──
  //
  // On a project route the project is fixed and the picker is pointless; on
  // `/app` it is the control that decides whether this turn can touch code.
  const composer = createComposer({
    mode: query.mode || conversation?.mode || 'agent',
    projectId,
    showProjectPicker: !params.id,
    placeholder: project
      ? `Tell DiroxCode what you want to build in ${project.name}…`
      : undefined,
    onSend: (text, options) => runTask(text, options),
    onStop: () => stopCurrent()
  });
  view.appendChild(composer.element);

  registerCommands('workspace', [
    ...(projectId ? [
      { id: 'files', group: 'Chat', label: 'Show project files', icon: 'file', run: () => openTreePanel(projectId) },
      { id: 'changes', group: 'Chat', label: 'Show changed files', icon: 'layers', run: () => openChangesPanel(projectId, lastChangedFiles) },
      { id: 'project', group: 'Chat', label: 'Open project overview', icon: 'projects', run: () => router.navigate(`/app/projects/${projectId}`) },
      { id: 'preview', group: 'Chat', label: 'Preview the app', icon: 'play', run: () => openPreviewPanel(projectId) }
    ] : []),
    { id: 'stop', group: 'Chat', label: 'Stop the agent', icon: 'stop', hint: 'Esc', run: () => stopCurrent() }
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

  async function runTask(text, { mode, attachments, projectId: chosenProjectId, modelId }) {
    // On `/app` the project is chosen per turn; adopt it for this chat.
    if (!params.id && chosenProjectId !== undefined) projectId = chosenProjectId;

    // The welcome screen is replaced by the first real turn.
    thread.querySelector('.chat__welcome')?.remove();

    /*
      Attachments.

      Text is inlined, because the content is the point and the model can read
      it. Anything else is uploaded and named: a logo is not something to
      describe, it is something to put in the repository, and `place_upload`
      is how the agent does that. Dropping it with an apology — which is what
      used to happen — made "add this logo" unanswerable.
    */
    let objective = text;
    const uploaded = [];

    for (const attachment of attachments || []) {
      if (attachment.type === 'text') {
        objective += `\n\nAttached file "${attachment.name}":\n\`\`\`\n${String(attachment.content).slice(0, 20_000)}\n\`\`\``;
        continue;
      }

      try {
        const { upload } = await api.upload(
          `/uploads${projectId ? `?projectId=${projectId}` : ''}`, attachment.file);
        uploaded.push(upload);
      } catch (error) {
        toastError(error, `${attachment.name} could not be uploaded`);
      }
    }

    if (uploaded.length) {
      objective += `\n\nUploaded: ${uploaded.map(file => `"${file.name}" (${file.size}, ${file.contentType})`).join(', ')}.`;
      objective += projectId
        ? ' Use `place_upload` to put each one where it belongs in the project.'
        : ' Open a project first if these should be added to a repository.';
    }

    thread.appendChild(userMessage(text));
    scrollToEnd();

    const activity = createActivity({ onFileClick });
    const bubble = assistantMessage({ activityElement: activity.element, onFileClick });
    const files = h('div.deliverables');
    const deliveredIds = new Set();
    bubble.element.insertBefore(files, bubble.foot);
    thread.appendChild(bubble.element);
    scrollToEnd();

    composer.setRunning(true);

    // Conversation is created lazily, so a one-off question costs no row.
    if (!conversation) {
      try {
        const created = await api.post('/conversations', { projectId: projectId || undefined, mode });
        conversation = created.conversation;
        history.replaceState({}, '', projectId
          ? `/app/projects/${projectId}/chat/${conversation.id}`
          : `/app/chat/${conversation.id}`);
        // The sidebar's chat list is the main way back to this conversation.
        refreshConversations();
      } catch { /* the task still runs without a conversation record */ }
    }
    if (conversation) {
      api.post(`/conversations/${conversation.id}/messages`, { role: 'user', content: text }).catch(() => {});
    }

    let task;
    try {
      const created = await api.post('/tasks', {
        objective,
        projectId: projectId || undefined,
        conversationId: conversation?.id,
        modelId: modelId || undefined,
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
          case 'delegate': activity.delegate(data); break;
          case 'deliverable':
            // Shown the moment it exists rather than only in the summary: a
            // long run should hand over the file as soon as it is ready.
            if (!deliveredIds.has(data.id)) {
              deliveredIds.add(data.id);
              files.appendChild(deliverableCard(data));
            }
            break;
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

      if (lastChangedFiles.length && projectId) openChangesPanel(projectId, lastChangedFiles);
      scrollToEnd();
    }
  }

  composer.focus();
  scrollToEnd();

  return () => { closeStream(); clearCommands('workspace'); };
}
