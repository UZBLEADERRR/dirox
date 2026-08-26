/** Accessible modal dialog. On mobile the same markup renders as a bottom sheet. */

import { h, icon, trapFocus } from '../lib/dom.js';

/**
 * @param {{title:string, body:Node, actions?:Node[], wide?:boolean, onClose?:Function}} options
 * @returns {{ close: () => void, element: HTMLElement }}
 */
export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  const close = () => {
    release?.();
    overlay.remove();
    onClose?.();
  };

  const panel = h(`div.modal${wide ? '.modal--wide' : ''}`, {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': title
  },
    h('div.modal__head',
      h('h2.modal__title', title),
      h('button.btn.btn--ghost.btn--icon.btn--sm', { 'aria-label': 'Close', onClick: close }, icon('close', { size: 15 }))
    ),
    h('div.modal__body', body),
    actions.length ? h('div.modal__foot', actions) : null
  );

  const overlay = h('div.overlay', {
    onClick: event => { if (event.target === overlay) close(); }
  }, panel);

  document.body.appendChild(overlay);
  const release = trapFocus(panel, { onEscape: close });

  return { close, element: panel };
}

/** Destructive confirmation. Optionally requires typing an exact phrase. */
export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = true, requirePhrase = '' , onConfirm }) {
  let input = null;
  const confirmButton = h(`button.btn${danger ? '.btn--danger' : '.btn--primary'}`, {
    disabled: Boolean(requirePhrase),
    onClick: async () => {
      confirmButton.disabled = true;
      try { await onConfirm(); modal.close(); }
      catch { confirmButton.disabled = false; }
    }
  }, confirmLabel);

  if (requirePhrase) {
    input = h('input.input', {
      placeholder: requirePhrase,
      'aria-label': `Type ${requirePhrase} to confirm`,
      onInput: event => { confirmButton.disabled = event.target.value.trim() !== requirePhrase; }
    });
  }

  const modal = openModal({
    title,
    body: h('div.stack',
      h('p.muted', { style: { fontSize: 'var(--fs-sm)' } }, message),
      requirePhrase ? h('div.field',
        h('label.label', `Type “${requirePhrase}” to confirm`),
        input
      ) : null
    ),
    actions: [
      h('button.btn', { onClick: () => modal.close() }, 'Cancel'),
      confirmButton
    ]
  });

  return modal;
}
