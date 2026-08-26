/** Account menu anchored to the sidebar chip. */

import { h, icon, trapFocus } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { api } from '../lib/api.js';
import { initials } from '../lib/format.js';

export function openUserMenu(anchor) {
  const session = store.state.session;
  const rect = anchor.getBoundingClientRect();

  const item = (label, iconName, onClick, options = {}) => h('button.palette__item', {
    role: 'menuitem',
    style: options.danger ? { color: 'var(--danger)' } : {},
    onClick: () => { close(); onClick(); }
  }, icon(iconName, { size: 15 }), h('span', label));

  const menu = h('div.palette', {
    role: 'menu',
    style: {
      position: 'fixed',
      left: `${Math.max(8, rect.left)}px`,
      bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`,
      width: `${Math.max(240, rect.width)}px`,
      maxWidth: 'calc(100vw - 16px)',
      margin: '0'
    }
  },
    h('div', { style: { padding: 'var(--s-4)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 'var(--s-3)', alignItems: 'center' } },
      h('span.avatar', session?.profile?.avatarUrl
        ? h('img', { src: session.profile.avatarUrl, alt: '' })
        : initials(session?.profile?.fullName, session?.user?.email)),
      h('div', { style: { minWidth: '0' } },
        h('div.truncate', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text-strong)' } }, session?.profile?.fullName || 'Account'),
        h('div.truncate.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, session?.user?.email || '')
      )
    ),
    h('div', { style: { padding: 'var(--s-2)' } },
      item('Profile and preferences', 'user', () => router.navigate('/app/settings')),
      item('Usage and cost', 'chart', () => router.navigate('/app/settings/usage')),
      item('Billing', 'credit', () => router.navigate('/app/settings/billing')),
      item('Security', 'shield', () => router.navigate('/app/settings/security')),
      session?.isPlatformAdmin ? item('Admin dashboard', 'settings', () => router.navigate('/admin')) : null
    ),
    h('div', { style: { padding: 'var(--s-2)', borderTop: '1px solid var(--border)' } },
      item('Sign out', 'logout', signOut, { danger: true })
    )
  );

  async function signOut() {
    try { await api.post('/auth/logout', {}); } catch { /* the local session is cleared regardless */ }
    api.setToken('');
    api.setOrg('');
    store.reset();
    router.navigate('/', { replace: true });
  }

  function close() {
    release?.();
    overlay.remove();
  }

  const overlay = h('div', {
    style: { position: 'fixed', inset: '0', zIndex: 'var(--z-modal)' },
    onClick: event => { if (event.target === overlay) close(); }
  }, menu);

  document.body.appendChild(overlay);
  const release = trapFocus(menu, { onEscape: close });
}
