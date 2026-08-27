/**
 * The application shell.
 *
 * One sidebar holds everything. Destinations come first — projects and the
 * handful of pages that are not chat — because they are a fixed, short list
 * you navigate by position. Chat history sits underneath them: it is long,
 * it reorders itself constantly, and putting it on top would push everything
 * else off the screen as soon as you had a few conversations.
 *
 * There is no bottom tab bar — on a phone the same sidebar slides in as a
 * drawer, so there is one navigation to learn instead of two that disagree.
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
import { initials, shortTime } from '../lib/format.js';
import { openCommandPalette } from './palette.js';
import { openUserMenu } from './user-menu.js';
import { toastError } from '../lib/toast.js';

/**
 * Subscribe and paint once.
 *
 * `store.subscribe` fires on change only, so a view built after its data
 * arrived would render empty and stay that way until the next update. Every
 * live region in the sidebar binds through here instead.
 */
function bind(selector, render) {
  store.subscribe(selector, render);
  render(selector(store.state), store.state);
}

let shell = null;
let viewSlot = null;
let contextGroup = null;
let titleSlot = null;
let panelBody = null;
let panelTabs = null;

/** Everything that is not a conversation, in the order it is reached for. */
const NAV = [
  ['/app/projects', 'projects', 'All projects'],
  ['/app/tasks', 'tasks', 'Tasks'],
  ['/app/overview', 'chart', 'Overview'],
  ['/app/settings', 'settings', 'Settings']
];

function navItem([href, iconName, label], { meta } = {}) {
  return h('a.nav-item', { href },
    icon(iconName, { size: 16, className: 'nav-item__icon' }),
    h('span.nav-item__label', label),
    meta ? h('span.nav-item__meta', meta) : null
  );
}

/**
 * Mark the current page.
 *
 * The longest matching link wins, so `/admin` does not light up while you are
 * on `/admin/models`, and neither does `/app` while you are in a project.
 */
function syncActiveNav() {
  const path = location.pathname;
  const links = [...shell.querySelectorAll('.nav-item[href]')];

  let best = null;
  for (const link of links) {
    const href = link.getAttribute('href');
    if (path !== href && !path.startsWith(`${href}/`)) continue;
    if (!best || href.length > best.getAttribute('href').length) best = link;
  }

  for (const link of links) {
    if (link === best) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/**
 * Recent conversations.
 *
 * Capped rather than paged, and placed last: a list that grows without bound
 * must not be the thing standing between you and the Settings link.
 */
function conversationsGroup() {
  const list = h('div.nav-list');
  const group = h('nav.nav-group',
    h('div.nav-group__label', h('span', 'Chats')),
    list
  );

  bind(s => s.conversations, conversations => {
    clear(list);
    if (!conversations.length) {
      list.appendChild(h('p.nav-empty', 'Your conversations will appear here.'));
      return;
    }
    for (const conversation of conversations.slice(0, 12)) {
      list.appendChild(h('a.nav-item', { href: chatHref(conversation), title: conversation.title },
        h('span.nav-item__label', conversation.title || 'Untitled'),
        h('span.nav-item__meta', shortTime(conversation.updatedAt))
      ));
    }
    syncActiveNav();
  });

  return group;
}

function chatHref(conversation) {
  return conversation.projectId
    ? `/app/projects/${conversation.projectId}/chat/${conversation.id}`
    : `/app/chat/${conversation.id}`;
}

function projectsGroup() {
  const list = h('div.nav-list');
  const group = h('nav.nav-group',
    h('div.nav-group__label',
      h('span', 'Projects'),
      h('a.nav-group__action', { href: '/app/projects', 'aria-label': 'All projects' }, icon('plus', { size: 13 }))
    ),
    list
  );

  bind(s => s.projects, projects => {
    clear(list);
    if (!projects.length) {
      list.appendChild(h('a.nav-item', { href: '/app/projects' },
        icon('plus', { size: 15, className: 'nav-item__icon' }),
        h('span.nav-item__label', 'Connect a project')));
      return;
    }
    for (const project of projects.slice(0, 5)) {
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
  const userChip = h('button.user-chip', { 'aria-haspopup': 'menu', onClick: event => openUserMenu(event.currentTarget) });
  bind(s => s.session, s => {
    mount(userChip,
      h('span.avatar', s?.profile?.avatarUrl
        ? h('img', { src: s.profile.avatarUrl, alt: '' })
        : initials(s?.profile?.fullName, s?.user?.email)),
      h('span.user-chip__text',
        h('div.truncate.user-chip__name', s?.profile?.fullName || 'Account'),
        h('div.truncate.user-chip__org', s?.organization?.name || '')
      ),
      icon('chevronRight', { size: 13, className: 'nav-item__icon' })
    );
  });

  const adminGroup = h('nav.nav-group');
  bind(s => s.session?.isPlatformAdmin, isAdmin => {
    clear(adminGroup);
    if (isAdmin) adminGroup.appendChild(navItem(['/admin', 'shield', 'Admin']));
  });

  // A page with sections of its own (the admin panel) puts them here, so the
  // sidebar remains the only place navigation lives.
  contextGroup = h('nav.nav-group', { hidden: true });

  return h('aside.sidebar',
    h('div.sidebar__brand',
      h('a.brand', { href: '/app', 'aria-label': 'DiroxCode' },
        mark({ size: 22 }),
        h('span.sidebar__wordmark', 'Dirox', h('span', 'Code'))
      ),
      h('button.btn.btn--ghost.btn--icon.btn--sm.sidebar__collapse', {
        'aria-label': 'Collapse sidebar',
        title: 'Collapse sidebar (⌘B)',
        onClick: () => store.setUi({ sidebar: store.state.ui.sidebar === 'collapsed' ? 'expanded' : 'collapsed' })
      }, icon('panel', { size: 15 }))
    ),

    h('div.sidebar__top',
      h('a.btn.btn--primary.btn--block.sidebar__new', { href: '/app' },
        icon('plus', { size: 15 }), h('span.nav-item__label', 'New chat')),
      h('button.nav-item.nav-item--search', { onClick: () => openCommandPalette() },
        icon('search', { size: 16, className: 'nav-item__icon' }),
        h('span.nav-item__label', 'Search'),
        h('kbd', '⌘K')
      )
    ),

    h('div.sidebar__scroll',
      contextGroup,
      projectsGroup(),
      h('nav.nav-group', NAV.map(item => navItem(item))),
      adminGroup,
      conversationsGroup()
    ),

    h('div.sidebar__foot', userChip)
  );
}

function topbar() {
  titleSlot = h('div.breadcrumb');

  const unreadDot = h('span.dot.dot--danger.topbar__unread', { hidden: true });
  const notificationsWrap = h('div.topbar__notify',
    h('button.btn.btn--ghost.btn--icon.btn--sm', {
      'aria-label': 'Notifications',
      onClick: () => router.navigate('/app/settings/notifications')
    }, icon('bell', { size: 16 })),
    unreadDot
  );
  bind(s => s.unreadCount, count => { unreadDot.hidden = !(count > 0); });

  return h('header.topbar',
    h('button.btn.btn--ghost.btn--icon.btn--sm.topbar__menu', {
      'aria-label': 'Open navigation',
      onClick: () => store.setUi({ drawer: store.state.ui.drawer === 'open' ? 'closed' : 'open' })
    }, icon('menu', { size: 17 })),
    titleSlot,
    h('div.topbar__spacer'),
    notificationsWrap,
    h('button.btn.btn--ghost.btn--icon.btn--sm.topbar__panel', {
      'aria-label': 'Toggle work panel',
      title: 'Work panel (⌘\\)',
      onClick: () => store.setUi({ panel: store.state.ui.panel === 'open' ? 'closed' : 'open' })
    }, icon('layers', { size: 16 }))
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

  return h('section.workpanel', resizer, panelTabs, panelBody);
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
    workPanel()
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
 * @param {{ title?: string, crumbs?: Array<[string,string]>, fill?: boolean }} options
 */
export function renderInShell(content, { title = '', crumbs = [], fill = false } = {}) {
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

  // A page's own sections belong to that page; the next navigation clears
  // them unless it sets its own.
  clearSidebarSection();

  document.title = title ? `${title} · DiroxCode` : 'DiroxCode';
  // A page that fills the viewport (chat) must not also scroll the view.
  viewSlot.dataset.fill = fill ? 'true' : 'false';
  mount(viewSlot, content);
  viewSlot.scrollTop = 0;
  syncActiveNav();
  store.setUi({ drawer: 'closed' });
}

/**
 * Give the sidebar a group of sections belonging to the current page.
 *
 * Call it after `renderInShell`, which clears whatever the previous page set.
 *
 * @param {{label:string, items: Array<{href:string,label:string,icon?:string}>}} section
 */
export function setSidebarSection({ label, items = [] } = {}) {
  if (!contextGroup) return;
  contextGroup.hidden = items.length === 0;
  mount(contextGroup,
    label ? h('div.nav-group__label', h('span', label)) : null,
    items.map(item => navItem([item.href, item.icon || 'chevronRight', item.label]))
  );
  syncActiveNav();
}

export function clearSidebarSection() {
  if (!contextGroup) return;
  contextGroup.hidden = true;
  clear(contextGroup);
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

/**
 * Sidebar data is loaded once per session and refreshed on demand.
 *
 * Each request degrades on its own: a failing notifications endpoint must not
 * empty the project list.
 */
export async function loadSidebarData() {
  try {
    const [{ projects }, conversations, notifications] = await Promise.all([
      api.get('/projects?limit=20'),
      api.get('/conversations?limit=15').catch(() => ({ conversations: [] })),
      api.get('/notifications?limit=20').catch(() => ({ notifications: [], unread: 0 }))
    ]);
    store.set({
      projects,
      conversations: conversations.conversations || [],
      notifications: notifications.notifications || [],
      unreadCount: notifications.unread || 0
    });
  } catch (error) {
    if (!error?.isAuth) toastError(error, 'Could not load your projects');
  }
}

/** Called after a conversation is created or renamed, so the list stays true. */
export async function refreshConversations() {
  try {
    const { conversations } = await api.get('/conversations?limit=15');
    store.set({ conversations });
  } catch { /* the sidebar simply keeps what it has */ }
}

export function shellElement() { return shell; }
