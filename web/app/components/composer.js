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
import { toastError } from '../lib/toast.js';

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
  const projectListeners = new Set();

  // Short enough to fit one line on a phone: a clipped placeholder is the
  // first thing a new user sees, and it reads as a broken field.
  const defaultPlaceholder = placeholder || 'Ask DiroxCode anything…';

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
    onChange: event => { mode = event.target.value; syncModeAvailability(); fitSelect(modeSelect); }
  }, MODES.map(([id, label, description]) => h('option', { value: id, title: description }, label)));
  modeSelect.value = mode;

  const projectSelect = h('select.select.select--bare', {
    'aria-label': 'Project',
    onChange: event => {
      projectId = event.target.value || null;
      syncModeAvailability();
      fitSelect(projectSelect);
      for (const listener of projectListeners) listener(projectId);
    }
  });

  const modelSelect = h('select.select.select--bare', {
    'aria-label': 'Model',
    onChange: () => fitSelect(modelSelect)
  });

  /*
     Still built, never in the bar.

     The header's menu drives the same `<select>`, so keeping it in the tree —
     hidden — means one source of truth for the chosen project and no second
     copy of the list to keep in step.
  */
  const projectWrap = h('label.composer__picker.composer__picker--offstage', { hidden: true },
    icon('folder', { size: 12 }), projectSelect);

  const modelWrap = h('label.composer__picker', { hidden: true },
    icon('sparkle', { size: 12 }), modelSelect);

  /*
     A `<select>` is as wide as its widest option, not as wide as the option
     it is showing.

     That is invisible on a desktop and ruinous on a phone: "Auto" sat in a
     125-pixel pill because "Dirox Reason" was further down the list, and the
     three pills together overflowed a 390-pixel screen. So each one is
     measured against the text it is actually displaying.

     The gauge is a real span in the same box, so it inherits the same font
     without anything having to be kept in sync.
  */
  const gauge = h('span.composer__gauge', { 'aria-hidden': 'true' });

  /** Room for the chevron the browser draws inside the select. */
  const CHEVRON = 22;

  function fitSelect(select) {
    const label = select.selectedOptions[0]?.textContent ?? '';
    if (!label) return;
    gauge.textContent = label;
    const width = gauge.getBoundingClientRect().width;
    // Before the composer is in the document there is nothing to measure, and
    // a width of zero would collapse the pill. Leave it to the next call.
    if (width > 0) select.style.width = `${Math.ceil(width) + CHEVRON}px`;
  }

  function fitAll() {
    for (const select of [projectSelect, modeSelect, modelSelect]) fitSelect(select);
  }

  /**
   * Only models an administrator has opened to users appear here. The server
   * enforces the same list, so a stale page cannot reach a closed model.
   */
  function renderModels(models, defaultModelId) {
    modelWrap.hidden = models.length === 0;
    mount(modelSelect,
      h('option', { value: '' }, 'Auto'),
      models.map(model => h('option', { value: model.id, title: model.description || '' }, model.name))
    );
    if (defaultModelId && models.some(model => model.id === defaultModelId)) modelSelect.value = defaultModelId;
    fitSelect(modelSelect);
  }

  function renderProjects(projects) {
    mount(projectSelect,
      h('option', { value: '' }, 'No project'),
      projects.map(project => h('option', { value: project.id }, project.name))
    );
    projectSelect.value = projectId || '';
    fitSelect(projectSelect);
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
    accept: 'image/*,text/*,.log,.txt,.json,.diff,.patch,.pdf,.zip,.svg,.csv,.yml,.yaml',
    multiple: true,
    hidden: true,
    onChange: event => addAttachments([...event.target.files])
  });

  function addAttachments(files) {
    for (const file of files.slice(0, 6)) {
      // The server caps this too; refusing here means saying why.
      if (file.size > 25 * 1024 * 1024) {
        toastError(new Error(`${file.name} is larger than 25MB`), 'That file is too large to attach');
        continue;
      }
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

    /*
      Text is read here so it can be inlined; everything else travels as the
      File itself, to be uploaded. Reading a 20MB PNG into a data URL only to
      hand it back as bytes is work nobody needs done.
    */
    const payload = [];
    for (const file of attachments) {
      const isText = file.type.startsWith('text/') || /\.(txt|md|json|csv|log|ya?ml|diff|patch|ts|js|py|rb|go|rs|java|sql|html|css)$/i.test(file.name);
      payload.push(isText
        ? { name: file.name, type: 'text', content: await file.text(), file }
        : { name: file.name, type: 'binary', contentType: file.type, file });
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
        gauge,
        projectWrap,
        input,
        attachmentBar,
        h('div.composer__bar',
          /*
             Three controls, not four.

             The project picker moved to the header's overflow menu. It is
             chosen once for a conversation and then never touched, while the
             other three are per-message — and on a phone a fourth pill pushed
             the row onto a second line for something nobody was adjusting.
          */
          h('div.composer__tools',
            attachButton,
            filePicker,
            h('label.composer__picker.composer__picker--plain', modeSelect),
            modelWrap
          ),
          h('span.composer__hint', h('kbd', '↵'), ' send'),
          stopButton,
          sendButton
        )
      )
    )
  );

  // The placeholder alone can need two lines, so the box is sized before it is
  // ever typed into rather than on the first keystroke. The pills are measured
  // in the same frame, for the same reason: nothing can be measured until the
  // composer is in the document.
  requestAnimationFrame(() => { autoResize(); fitAll(); });

  return {
    element,
    focus: () => input.focus(),
    get mode() { return mode; },
    get projectId() { return projectId; },

    setMode(next) { mode = next; modeSelect.value = next; syncModeAvailability(); fitSelect(modeSelect); },

    setProject(id) {
      projectId = id || null;
      projectSelect.value = projectId || '';
      syncModeAvailability();
      fitSelect(projectSelect);
    },

    /** The header menu asks what the choices are, and says when one is made. */
    get projectsPickable() { return showProjectPicker; },
    onProjectChange(listener) { projectListeners.add(listener); return () => projectListeners.delete(listener); },

    setRunning(value) {
      running = value;
      sendButton.hidden = value;
      stopButton.hidden = !value;
      input.placeholder = value ? 'DiroxCode is working…' : defaultPlaceholder;
    },

    setValue(text) { input.value = text; autoResize(); }
  };
}

export { MODES };
