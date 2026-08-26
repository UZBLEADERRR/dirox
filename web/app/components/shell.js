/**
 * The application shell.
 *
 * Built once and reused across navigations, so switching pages never rebuilds
 * the sidebar or loses panel state. Pages call `renderInShell()` with their
 * content and a title.
 */

import { h, icon, mount, clear, qs } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { api } from '../lib/api.js';
import { mark } from './brand.js';
import { initials } from '../lib/format.js';
import { openCommandPalette } from './palette.js';
import { openUserMenu } from './user-menu.js';
import { toastError } from '../lib/toast.js';

let shell = null;
let viewSlot = null;
let titleSlot = null;
let panelBody = null;
let panelTabs = null;

const NAV = [
  ['/app', 'home', 'Home'],
  ['/app/projects', 'projects', 'Projects'],
  ['/app/tasks', 'tasks', 'Tasks']
];

const MOBILE_NAV = [
  ['/app', 'home', 'Home'],
  ['/app/projects', 'projects', 'Projects'],
  ['/app/tasks', 'tasks', 'Tasks'],
  ['/app/settings', 'user', 'You']
];

function navItem([href, iconName, label], { meta } = {}) {
  const element = h('a.nav-item', { href },
    icon(iconName, { size: 16, className: 'nav-item__icon' }),
    h('span.nav-item__label', label),
    meta ? h('span.nav-item__meta', meta) : null
  );
  return element;
}

function syncActiveNav() {
  const path = location.pathname;
  for (const link of shell.querySelectorAll('.nav-item[href], .mobile-nav__item[href]')) {
    const href = link.getAttribute('href');
    const active = href === '/app' ? path === '/app' : path.startsWith(href);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function recentProjectsGroup() {
  const list = h('div.stack--tight', { class: 'stack' });
  const group = h('nav.nav-group',
    h('div.nav-group__label',
      h('span', 'Projects'),
      h('a', { href: '/app/projects', 'aria-label': 'All projects', style: { color: 'var(--text-subtle)' } }, icon('plus', { size: 13 }))
    ),
    list
  );

  store.subscribe(s => s.projects, projects => {
    clear(list);
    const recent = projects.slice(0, 6);
    if (!recent.length) {
      list.appendChild(h('a.nav-item', { href: '/app/projects' },
        icon('plus', { size: 15, className: 'nav-item__icon' }),
        h('span.nav-item__label', 'Connect a project')));
      return;
    }
    for (const project of recent) {
      list.appendChild(h('a.nav-item', { href: `/app/projects/${project.id}` },
        icon('folder', { size: 15, className: 'nav-item__icon' }),
        h('span.nav-item__label', project.name),
        project.indexStatus === 'running' ? h('span.dot.dot--pulse') : null
      ));
    }
    syncActiveNav();
  });

  return group;
}

function sidebar() {
  const session = store.state.session;

  const userChip = h('button.user-chip', { 'aria-haspopup': 'menu', onClick: event => openUserMenu(event.currentTarget) });
  store.subscribe(s => s.session, s => {
    mount(userChip,
      h('span.avatar', s?.profile?.avatarUrl
        ? h('img', { src: s.profile.avatarUrl, alt: '' })
        : initials(s?.profile?.fullName, s?.user?.email)),
      h('span.user-chip__text', { style: { flex: '1', minWidth: '0', textAlign: 'left' } },
        h('div.truncate', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text)' } }, s?.profile?.fullName || 'Account'),
        h('div.truncate.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, s?.organization?.name || '')
      ),
      icon('chevronRight', { size: 13, className: 'nav-item__icon' })
    );
  });
  // Prime it once for the initial paint.
  store.set({ session });

  return h('aside.sidebar',
    h('div.sidebar__brand',
      h('a.brand', { href: '/app', 'aria-label': 'DiroxCode home' },
        mark({ size: 22 }),
        h('span.sidebar__wordmark', 'Dirox', h('span', 'Code'))
      )
    ),

    h('div.sidebar__scroll',
      h('nav.nav-group',
        h('button.nav-item', { onClick: () => openCommandPalette(), style: { width: '100%' } },
          icon('search', { size: 16, className: 'nav-item__icon' }),
          h('span.nav-item__label', 'Search'),
          h('kbd', '⌘K')
        )
      ),
      h('nav.nav-group', NAV.map(item => navItem(item))),
      recentProjectsGroup(),
      session?.isPlatformAdmin
        ? h('nav.nav-group',
            h('div.nav-group__label', 'Platform'),
            navItem(['/admin', 'chart', 'Admin']))
        : null
    ),

    h('div.sidebar__foot', userChip)
  );
}

function topbar() {
  titleSlot = h('div.breadcrumb');

  const notificationsButton = h('button.btn.btn--ghost.btn--icon.btn--sm', {
    'aria-label': 'Notifications',
    onClick: () => router.navigate('/app/settings/notifications')
  }, icon('bell', { size: 16 }));

  const unreadDot = h('span.dot.dot--danger', { style: { position: 'absolute', top: '4px', right: '4px', display: 'none' } });
  const notificationsWrap = h('div', { style: { position: 'relative' } }, notificationsButton, unreadDot);
  store.subscribe(s => s.unreadCount, count => { unreadDot.style.display = count > 0 ? 'block' : 'none'; });

  return h('header.topbar',
    h('button.btn.btn--ghost.btn--icon.btn--sm', {
      'aria-label': 'Open navigation',
      class: 'topbar__menu',
      onClick: () => store.setUi({ drawer: store.state.ui.drawer === 'open' ? 'closed' : 'open' })
    }, icon('menu', { size: 17 })),
    titleSlot,
    h('div.topbar__spacer'),
    h('button.btn.btn--ghost.btn--sm', { onClick: () => openCommandPalette() }, icon('search', { size: 14 }), h('kbd', '⌘K')),
    notificationsWrap,
    h('button.btn.btn--ghost.btn--icon.btn--sm', {
      'aria-label': 'Toggle work panel',
      onClick: () => store.setUi({ panel: store.state.ui.panel === 'open' ? 'closed' : 'open' })
    }, icon('panel', { size: 16 }))
  );
}

function workPanel() {
  panelTabs = h('div.workpanel__tabs');
  panelBody = h('div.workpanel__body');

  const resizer = h('div.panel-resizer', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize panel' });
  resizer.addEventListener('pointerdown', event => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.dataset.dragging = 'true';
    const move = e => {
      const width = Math.min(720, Math.max(300, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--panel-w', `${width}px`);
    };
    const up = e => {
      resizer.dataset.dragging = 'false';
      resizer.releasePointerCapture(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.setUi({ panelWidth: Math.min(720, Math.max(300, window.innerWidth - e.clientX)) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  return h('section.workpanel', { style: { position: 'relative' } }, resizer, panelTabs, panelBody);
}

function mobileNav() {
  return h('nav.mobile-nav', { 'aria-label': 'Primary' },
    MOBILE_NAV.map(([href, iconName, label]) => h('a.mobile-nav__item', { href },
      icon(iconName, { size: 20, className: 'mobile-nav__icon' }),
      h('span', label)
    ))
  );
}

function buildShell() {
  viewSlot = h('div.view', { id: 'main', tabindex: '-1' });

  shell = h('div.app', {
    'data-sidebar': store.state.ui.sidebar,
    'data-panel': store.state.ui.panel,
    'data-drawer': store.state.ui.drawer
  },
    h('div.sheet-backdrop', { onClick: () => store.setUi({ drawer: 'closed' }) }),
    sidebar(),
    h('main.main', topbar(), viewSlot),
    workPanel(),
    mobileNav()
  );

  document.documentElement.style.setProperty('--panel-w', `${store.state.ui.panelWidth}px`);

  store.subscribe(s => s.ui, ui => {
    shell.dataset.sidebar = ui.sidebar;
    shell.dataset.panel = ui.panel;
    shell.dataset.drawer = ui.drawer;
  });

  installShortcuts();
  return shell;
}

function installShortcuts() {
  document.addEventListener('keydown', event => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable;
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === 'k') { event.preventDefault(); return openCommandPalette(); }
    if (meta && event.key.toLowerCase() === 'p') { event.preventDefault(); return openCommandPalette({ mode: event.shiftKey ? 'commands' : 'files' }); }
    if (meta && event.key === 'b' && !typing) { event.preventDefault(); return store.setUi({ sidebar: store.state.ui.sidebar === 'collapsed' ? 'expanded' : 'collapsed' }); }
    if (meta && event.key === '\\') { event.preventDefault(); return store.setUi({ panel: store.state.ui.panel === 'open' ? 'closed' : 'open' }); }
  });
}

/**
 * Render page content inside the shell.
 * @param {Node} content
 * @param {{ title?: string, crumbs?: Array<[string,string]>, panel?: {tabs: Array, active: string} }} options
 */
export function renderInShell(content, { title = '', crumbs = [] } = {}) {
  const root = qs('#root');
  if (!shell || !shell.isConnected) {
    root.setAttribute('aria-busy', 'false');
    mount(root, buildShell());
    loadSidebarData();
  }

  mount(titleSlot, crumbs.length
    ? crumbs.flatMap(([label, href], index) => [
        index ? h('span.breadcrumb__sep', '/') : null,
        href ? h('a.truncate', { href }, label) : h('span.topbar__title.truncate', label)
      ])
    : h('span.topbar__title', title));

  document.title = title ? `${title} · DiroxCode` : 'DiroxCode';
  mount(viewSlot, content);
  viewSlot.scrollTop = 0;
  syncActiveNav();
  store.setUi({ drawer: 'closed' });
}

/** Panel content is owned by the active page. */
export function setPanel({ tabs = [], active = '', body = null, open = true } = {}) {
  if (!panelTabs) return;
  mount(panelTabs,
    tabs.map(tab => h('button.tab', {
      role: 'tab',
      'aria-selected': String(tab.id === active),
      onClick: () => tab.onSelect?.(tab.id)
    }, tab.label)),
    h('div', { style: { flex: '1' } }),
    h('button.btn.btn--ghost.btn--icon.btn--sm', {
      'aria-label': 'Close panel',
      onClick: () => store.setUi({ panel: 'closed' })
    }, icon('close', { size: 14 }))
  );
  if (body) mount(panelBody, body);
  if (open) store.setUi({ panel: 'open', panelTab: active });
}

export function clearPanel() {
  if (panelTabs) clear(panelTabs);
  if (panelBody) clear(panelBody);
  store.setUi({ panel: 'closed' });
}

/** Sidebar data is loaded once per session and refreshed on demand. */
export async function loadSidebarData() {
  try {
    const [{ projects }, { notifications, unread }] = await Promise.all([
      api.get('/projects?limit=20'),
      api.get('/notifications?limit=20').catch(() => ({ notifications: [], unread: 0 }))
    ]);
    store.set({ projects, notifications, unreadCount: unread });
  } catch (error) {
    if (!error?.isAuth) toastError(error, 'Could not load your projects');
  }
}

export function shellElement() { return shell; }
