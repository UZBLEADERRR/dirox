/**
 * The task input.
 *
 * Polished and quiet: a text area, a mode picker, and a send button. Advanced
 * controls stay hidden until they are needed. Enter sends, Shift+Enter breaks
 * the line, Escape stops a running agent.
 */

import { h, icon, mount, clear } from '../lib/dom.js';
import { store } from '../lib/store.js';

const MODES = [
  ['agent', 'Agent', 'Plan, edit, test and report'],
  ['ask', 'Ask', 'Answer without changing anything'],
  ['debug', 'Debug', 'Find the root cause and prove the fix'],
  ['review', 'Review', 'Analyse without modifying'],
  ['plan', 'Plan', 'Produce a plan, change nothing'],
  ['autopilot', 'Autopilot', 'Continue until done or blocked']
];

/**
 * @param {{onSend:(text:string, options:object)=>void, onStop:()=>void, mode?:string, placeholder?:string}} options
 */
export function createComposer({ onSend, onStop, mode: initialMode = 'agent', placeholder } = {}) {
  let mode = initialMode;
  let running = false;
  const attachments = [];

  const input = h('textarea.composer__input', {
    rows: '1',
    placeholder: placeholder || 'Tell DiroxCode what you want to build…',
    'aria-label': 'Describe your task',
    spellcheck: 'true'
  });

  const attachmentBar = h('div.composer__attachments', { hidden: true });

  const modePicker = h('div.mode-picker', { role: 'group', 'aria-label': 'Agent mode' },
    MODES.map(([id, label, description]) => h('button.mode-picker__btn', {
      type: 'button',
      title: description,
      'aria-pressed': String(id === mode),
      onClick: () => {
        mode = id;
        for (const button of modePicker.children) {
          button.setAttribute('aria-pressed', String(button.textContent === label));
        }
      }
    }, label))
  );

  const sendButton = h('button.btn.btn--primary.btn--icon', {
    type: 'button',
    'aria-label': 'Send',
    title: 'Send (Enter)',
    onClick: () => submit()
  }, icon('arrowRight', { size: 15 }));

  const stopButton = h('button.btn.btn--danger.btn--sm', {
    type: 'button',
    hidden: true,
    title: 'Stop the agent (Esc)',
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
      h('span.truncate', { style: { maxWidth: '140px' } }, file.name),
      h('button', {
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

    onSend?.(text, { mode, attachments: payload });
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
          modePicker,
          attachButton,
          filePicker,
          h('div.composer__spacer'),
          h('span.composer__hint', h('kbd', '↵'), ' send · ', h('kbd', '⇧↵'), ' new line'),
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
    setMode(next) {
      mode = next;
      for (const button of modePicker.children) {
        const entry = MODES.find(([id]) => id === next);
        button.setAttribute('aria-pressed', String(entry && button.textContent === entry[1]));
      }
    },
    setRunning(value) {
      running = value;
      sendButton.hidden = value;
      stopButton.hidden = !value;
      input.placeholder = value ? 'DiroxCode is working…' : (placeholder || 'Tell DiroxCode what you want to build…');
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
