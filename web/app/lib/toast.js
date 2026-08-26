/** Transient feedback. Errors persist longer than confirmations. */

import { h, mount, icon } from './dom.js';

let container = null;

function ensureContainer() {
  if (container?.isConnected) return container;
  container = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(container);
  return container;
}

const ICON_FOR = { success: 'check', error: 'warning', warning: 'warning', info: 'sparkle' };

export function toast(message, { variant = 'info', title = '', durationMs } = {}) {
  const root = ensureContainer();
  const ms = durationMs ?? (variant === 'error' ? 7000 : 3800);

  const element = h(`div.toast.toast--${variant}`,
    icon(ICON_FOR[variant] || 'sparkle', { size: 15 }),
    h('div.toast__body',
      title ? h('div.toast__title', title) : null,
      h('div.toast__text', message)
    ),
    h('button.btn.btn--ghost.btn--icon.btn--sm', {
      'aria-label': 'Dismiss notification',
      onClick: () => element.remove()
    }, icon('close', { size: 13 }))
  );

  root.appendChild(element);
  const timer = setTimeout(() => {
    element.style.opacity = '0';
    element.style.transition = 'opacity 160ms';
    setTimeout(() => element.remove(), 180);
  }, ms);
  element.addEventListener('mouseenter', () => clearTimeout(timer), { once: true });
  return element;
}

toast.success = (message, options) => toast(message, { ...options, variant: 'success' });
toast.error = (message, options) => toast(message, { ...options, variant: 'error' });
toast.warning = (message, options) => toast(message, { ...options, variant: 'warning' });

/** Turn an ApiError into a message a user can act on. */
export function toastError(error, fallback = 'Something went wrong') {
  if (error?.name === 'AbortError') return null;
  const message = error?.message || fallback;
  const title = error?.isOffline ? 'Offline' : error?.isQuota ? 'Limit reached' : error?.isForbidden ? 'Not allowed' : '';
  return toast.error(message, { title });
}

export { mount };
