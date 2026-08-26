/**
 * The composer.
 *
 * One text area and one row of controls: what to work on, how to work, and
 * which model. Everything else — attachments, the stop button, the keyboard
 * hint — appears only when it applies.
 *
 * The three pickers are native `<select>` elements on purpose. They are one
 * tap on a phone, they are reachable by keyboard without any code, and the
 * design system already styles them; a bespoke dropdown would be more code
 * doing less.
 *
 * Enter sends, Shift+Enter breaks the line, Escape stops a running agent.
 */

import { h, icon, mount } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { api } from '../lib/api.js';

const MODES = [
  ['agent', 'Agent', 'Plan, edit, test and report'],
  ['ask', 'Ask', 'Answer without changing anything'],
  ['debug', 'Debug', 'Find the root cause and prove the fix'],
  ['review', 'Review', 'Analyse without modifying'],
  ['plan', 'Plan', 'Produce a plan, change nothing'],
  ['autopilot', 'Autopilot', 'Continue until done or blocked']
];

/** Modes that cannot do anything useful without a repository to work in. */
const NEEDS_PROJECT = new Set(['debug', 'review', 'autopilot']);

/**
 * @param {{
 *   onSend: (text: string, options: object) => void,
 *   onStop: () => void,
 *   mode?: string,
 *   projectId?: string|null,
 *   showProjectPicker?: boolean,
 *   placeholder?: string
 * }} options
 */
export function createComposer({
  onSend, onStop, mode: initialMode = 'agent',
  projectId: initialProjectId = null, showProjectPicker = false, placeholder
} = {}) {
  let mode = initialMode;
  let projectId = initialProjectId;
  let running = false;
  const attachments = [];

  const defaultPlaceholder = placeholder || 'Ask DiroxCode anything, or describe what to build…';

  const input = h('textarea.composer__input', {
    rows: '1',
    placeholder: defaultPlaceholder,
    'aria-label': 'Message DiroxCode',
    spellcheck: 'true'
  });

  const attachmentBar = h('div.composer__attachments', { hidden: true });

  // ── pickers ──
  const modeSelect = h('select.select.select--bare', {
    'aria-label': 'Mode',
    onChange: event => { mode = event.target.value; syncModeAvailability(); }
  }, MODES.map(([id, label, description]) => h('option', { value: id, title: description }, label)));
  modeSelect.value = mode;

  const projectSelect = h('select.select.select--bare', {
    'aria-label': 'Project',
    onChange: event => { projectId = event.target.value || null; syncModeAvailability(); }
  });

  const modelSelect = h('select.select.select--bare', { 'aria-label': 'Model' });

  const projectWrap = h('label.composer__picker', { hidden: !showProjectPicker },
    icon('folder', { size: 13 }), projectSelect);

  const modelWrap = h('label.composer__picker', { hidden: true },
    icon('sparkle', { size: 13 }), modelSelect);

  /**
   * Only models an administrator has opened to users appear here. The server
   * enforces the same list, so a stale page cannot reach a closed model.
   */
  function renderModels(models, defaultModelId) {
    modelWrap.hidden = models.length === 0;
    mount(modelSelect,
      h('option', { value: '' }, 'Automatic'),
      models.map(model => h('option', { value: model.id, title: model.description || '' }, model.name))
    );
    if (defaultModelId && models.some(model => model.id === defaultModelId)) modelSelect.value = defaultModelId;
  }

  function renderProjects(projects) {
    mount(projectSelect,
      h('option', { value: '' }, 'No project'),
      projects.map(project => h('option', { value: project.id }, project.name))
    );
    projectSelect.value = projectId || '';
  }

  /**
   * Some modes are meaningless without a repository. Disabling them is honest;
   * offering them and then failing is not.
   */
  function syncModeAvailability() {
    for (const option of modeSelect.options) {
      option.disabled = !projectId && NEEDS_PROJECT.has(option.value);
    }
    if (!projectId && NEEDS_PROJECT.has(mode)) {
      mode = 'agent';
      modeSelect.value = mode;
    }
  }

  store.subscribe(s => s.projects, renderProjects);
  store.subscribe(s => ({ models: s.models, defaultModelId: s.defaultModelId }),
    ({ models, defaultModelId }) => renderModels(models, defaultModelId));

  renderProjects(store.state.projects);
  renderModels(store.state.models, store.state.defaultModelId);
  syncModeAvailability();

  // The list is fetched once per session and shared by every composer.
  if (!store.state.models.length) {
    api.get('/me/models')
      .then(({ models, defaultModelId }) => store.set({ models, defaultModelId }))
      .catch(() => { /* the picker stays hidden and routing stays automatic */ });
  }

  // ── buttons ──
  const sendButton = h('button.btn.btn--primary.btn--icon.composer__send', {
    type: 'button', 'aria-label': 'Send', title: 'Send (Enter)',
    onClick: () => submit()
  }, icon('arrowRight', { size: 15 }));

  const stopButton = h('button.btn.btn--danger.btn--sm', {
    type: 'button', hidden: true, title: 'Stop the agent (Esc)',
    onClick: () => onStop?.()
  }, icon('stop', { size: 12 }), 'Stop');

  const attachButton = h('button.btn.btn--ghost.btn--icon.btn--sm', {
    type: 'button',
    'aria-label': 'Attach a file or screenshot',
    title: 'Attach a screenshot or file',
    onClick: () => filePicker.click()
  }, icon('plus', { size: 15 }));

  const filePicker = h('input', {
    type: 'file',
    accept: 'image/*,text/*,.log,.txt,.json,.diff,.patch',
    multiple: true,
    hidden: true,
    onChange: event => addAttachments([...event.target.files])
  });

  function addAttachments(files) {
    for (const file of files.slice(0, 4)) {
      if (file.size > 4 * 1024 * 1024) continue;
      attachments.push(file);
    }
    renderAttachments();
    filePicker.value = '';
  }

  function renderAttachments() {
    attachmentBar.hidden = attachments.length === 0;
    mount(attachmentBar, attachments.map((file, index) => h('span.attachment',
      icon(file.type.startsWith('image/') ? 'layers' : 'file', { size: 11 }),
      h('span.truncate.attachment__name', file.name),
      h('button.attachment__remove', {
        type: 'button',
        'aria-label': `Remove ${file.name}`,
        onClick: () => { attachments.splice(index, 1); renderAttachments(); }
      }, icon('close', { size: 10 }))
    )));
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(240, input.scrollHeight)}px`;
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || running) return;

    // Attachments are read as text; images are passed through as data URLs.
    const payload = [];
    for (const file of attachments) {
      const isImage = file.type.startsWith('image/');
      const content = await (isImage ? readAsDataUrl(file) : file.text());
      payload.push({ name: file.name, type: isImage ? 'image' : 'text', content });
    }

    input.value = '';
    autoResize();
    attachments.length = 0;
    renderAttachments();

    onSend?.(text, {
      mode,
      projectId,
      modelId: modelSelect.value || null,
      attachments: payload
    });
  }

  input.addEventListener('input', autoResize);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    if (event.key === 'Escape' && running) { event.preventDefault(); onStop?.(); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
  });

  // Pasting a screenshot attaches it.
  input.addEventListener('paste', event => {
    const images = [...(event.clipboardData?.items || [])]
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (images.length) { event.preventDefault(); addAttachments(images); }
  });

  const element = h('div.composer',
    h('div.composer__inner',
      h('div.composer__box',
        input,
        attachmentBar,
        h('div.composer__bar',
          h('div.composer__tools',
            attachButton,
            filePicker,
            projectWrap,
            h('label.composer__picker', icon('settings', { size: 13 }), modeSelect),
            modelWrap
          ),
          h('span.composer__hint', h('kbd', '↵'), ' send'),
          stopButton,
          sendButton
        )
      )
    )
  );

  return {
    element,
    focus: () => input.focus(),
    get mode() { return mode; },
    get projectId() { return projectId; },

    setMode(next) { mode = next; modeSelect.value = next; syncModeAvailability(); },

    setProject(id) {
      projectId = id || null;
      projectSelect.value = projectId || '';
      syncModeAvailability();
    },

    setRunning(value) {
      running = value;
      sendButton.hidden = value;
      stopButton.hidden = !value;
      input.placeholder = value ? 'DiroxCode is working…' : defaultPlaceholder;
    },

    setValue(text) { input.value = text; autoResize(); }
  };
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export { MODES };
