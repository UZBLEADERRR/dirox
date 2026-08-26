/**
 * Command palette (⌘K).
 *
 * Commands are registered by pages so the palette always reflects what is
 * actually possible right now — a "Run tests" entry only appears when a project
 * with a test command is open.
 */

import { h, icon, mount, trapFocus, debounce } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { api } from '../lib/api.js';

const contextual = new Map();
let openOverlay = null;

/** @param {string} scope  cleared when the page changes */
export function registerCommands(scope, commands) {
  contextual.set(scope, commands);
  return () => contextual.delete(scope);
}

export function clearCommands(scope) { contextual.delete(scope); }

function baseCommands() {
  const list = [
    { id: 'home', group: 'Go to', label: 'Home', icon: 'home', run: () => router.navigate('/app') },
    { id: 'projects', group: 'Go to', label: 'Projects', icon: 'projects', run: () => router.navigate('/app/projects') },
    { id: 'tasks', group: 'Go to', label: 'Tasks', icon: 'tasks', run: () => router.navigate('/app/tasks') },
    { id: 'settings', group: 'Go to', label: 'Settings', icon: 'settings', run: () => router.navigate('/app/settings') },
    { id: 'usage', group: 'Go to', label: 'Usage and cost', icon: 'chart', run: () => router.navigate('/app/settings/usage') },
    { id: 'new-project', group: 'Create', label: 'New project', icon: 'plus', hint: 'Connect a repository', run: () => router.navigate('/app/projects?new=1') },
    {
      id: 'theme', group: 'Preferences', label: 'Toggle theme', icon: 'sparkle',
      run: () => {
        const theme = store.state.ui.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme;
        store.setUi({ theme });
      }
    },
    {
      id: 'sidebar', group: 'Preferences', label: 'Toggle sidebar', icon: 'panel', hint: '⌘B',
      run: () => store.setUi({ sidebar: store.state.ui.sidebar === 'collapsed' ? 'expanded' : 'collapsed' })
    }
  ];

  if (store.state.session?.isPlatformAdmin) {
    list.push({ id: 'admin', group: 'Go to', label: 'Admin dashboard', icon: 'chart', run: () => router.navigate('/admin') });
  }

  for (const project of store.state.projects.slice(0, 8)) {
    list.push({
      id: `project:${project.id}`, group: 'Projects', label: project.name, icon: 'folder',
      hint: project.framework || project.language || '',
      run: () => router.navigate(`/app/projects/${project.id}`)
    });
  }

  return list;
}

function score(command, query) {
  if (!query) return 1;
  const label = command.label.toLowerCase();
  const q = query.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 60;
  if (label.includes(q)) return 40;
  // Subsequence match, so "rt" finds "Run tests".
  let index = 0;
  for (const char of q) {
    index = label.indexOf(char, index);
    if (index === -1) return 0;
    index += 1;
  }
  return 12;
}

export function openCommandPalette({ mode = 'all', initialQuery = '' } = {}) {
  if (openOverlay) return;

  let commands = [...baseCommands(), ...[...contextual.values()].flat()];
  if (mode === 'commands') commands = commands.filter(c => c.group !== 'Projects' && c.group !== 'Go to');

  let active = 0;
  let filtered = commands;

  const list = h('div.palette__list', { role: 'listbox' });
  const input = h('input.palette__input', {
    type: 'text',
    placeholder: mode === 'files' ? 'Search files…' : 'Search or run a command…',
    'aria-label': 'Command palette',
    autocomplete: 'off',
    spellcheck: 'false',
    value: initialQuery
  });

  function renderList() {
    mount(list);
    if (!filtered.length) {
      list.appendChild(h('div.empty', { style: { padding: 'var(--s-8)' } },
        h('p.empty__body', 'No matching command.')));
      return;
    }
    let group = null;
    filtered.forEach((command, index) => {
      if (command.group !== group) {
        group = command.group;
        list.appendChild(h('div.palette__group.eyebrow', group));
      }
      list.appendChild(h('button.palette__item', {
        role: 'option',
        'data-active': String(index === active),
        'aria-selected': String(index === active),
        onMouseEnter: () => { active = index; updateActive(); },
        onClick: () => execute(command)
      },
        icon(command.icon || 'arrowRight', { size: 15 }),
        h('span.truncate', command.label),
        command.hint ? h('span.palette__hint', command.hint) : null
      ));
    });
  }

  function updateActive() {
    [...list.querySelectorAll('.palette__item')].forEach((element, index) => {
      element.dataset.active = String(index === active);
      element.setAttribute('aria-selected', String(index === active));
      if (index === active) element.scrollIntoView({ block: 'nearest' });
    });
  }

  function applyFilter(query) {
    filtered = commands
      .map(command => ({ command, rank: score(command, query) }))
      .filter(entry => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .map(entry => entry.command);
    active = 0;
    renderList();
  }

  /**
   * Global search runs alongside the local command filter, so the palette finds
   * projects, files, symbols, tasks and conversations — not just commands.
   */
  const GROUP_FOR = { project: 'Projects', file: 'Files', symbol: 'Symbols', task: 'Tasks', conversation: 'Conversations' };
  const ICON_FOR = { project: 'folder', file: 'file', symbol: 'layers', task: 'tasks', conversation: 'chat' };

  const searchRemote = debounce(async query => {
    if (query.length < 2) return;
    const projectId = store.state.project?.id;
    try {
      const { results } = await api.get(
        `/search?q=${encodeURIComponent(query)}${projectId ? `&projectId=${projectId}` : ''}&limit=6`);

      const remote = Object.values(results).flat()
        .filter(item => item.href)
        .map(item => ({
          id: `${item.type}:${item.id || item.title}`,
          group: GROUP_FOR[item.type] || 'Results',
          label: item.title,
          hint: item.subtitle || '',
          icon: ICON_FOR[item.type] || 'arrowRight',
          remote: true,
          run: () => router.navigate(item.href)
        }));

      commands = [...commands.filter(command => !command.remote), ...remote];
      applyFilter(input.value.trim());
    } catch { /* search is a convenience; a failure leaves local commands working */ }
  }, 200);

  function execute(command) {
    close();
    try { command.run(); } catch (error) { console.error('command failed', error); }
  }

  function close() {
    release?.();
    overlay.remove();
    openOverlay = null;
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    applyFilter(query);
    searchRemote(query);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(filtered.length - 1, active + 1); updateActive(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, active - 1); updateActive(); }
    else if (event.key === 'Enter') { event.preventDefault(); if (filtered[active]) execute(filtered[active]); }
  });

  const panel = h('div.palette', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    input,
    list,
    h('div.palette__foot',
      h('span', h('kbd', '↑'), h('kbd', '↓'), ' navigate'),
      h('span', h('kbd', '↵'), ' select'),
      h('span', h('kbd', 'esc'), ' close')
    )
  );

  const overlay = h('div.overlay', {
    onClick: event => { if (event.target === overlay) close(); }
  }, panel);

  document.body.appendChild(overlay);
  openOverlay = overlay;
  const release = trapFocus(panel, { onEscape: close });
  applyFilter(initialQuery);
  input.focus();
  input.select();
}

export function paletteOpen() { return Boolean(openOverlay); }
