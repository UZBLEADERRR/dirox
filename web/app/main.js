/**
 * Client bootstrap: restore the session, register routes, start the router.
 */

import { api } from './lib/api.js';
import { store, restoreUi } from './lib/store.js';
import { router } from './lib/router.js';
import { h, mount, qs } from './lib/dom.js';
import { toastError } from './lib/toast.js';

const root = qs('#root');

/** Page modules load on demand; the landing page never pulls in the workspace. */
const pages = {
  landing: () => import('./pages/landing.js'),
  login: () => import('./pages/auth.js'),
  home: () => import('./pages/home.js'),
  projects: () => import('./pages/projects.js'),
  project: () => import('./pages/project.js'),
  workspace: () => import('./pages/workspace.js'),
  tasks: () => import('./pages/tasks.js'),
  task: () => import('./pages/task.js'),
  settings: () => import('./pages/settings.js'),
  admin: () => import('./pages/admin.js'),
  notFound: () => import('./pages/not-found.js')
};

function renderShellless(node) {
  root.setAttribute('aria-busy', 'false');
  mount(root, node);
}

async function bootSession() {
  const refreshed = await api.refreshSession();
  if (!refreshed) return null;
  try {
    const me = await api.get('/auth/me');
    api.setOrg(me.organization?.id || '');
    store.set({ session: me });
    return me;
  } catch (error) {
    if (error?.isAuth) return null;
    toastError(error, 'Could not load your account');
    return null;
  }
}

function registerRoutes() {
  router
    .add('/', async () => (store.state.session ? router.navigate('/app', { replace: true }) : (await pages.landing()).render(renderShellless)), { public: true })
    .add('/pricing', async () => (await pages.landing()).render(renderShellless, { section: 'pricing' }), { public: true })
    .add('/security', async () => (await pages.landing()).render(renderShellless, { section: 'security' }), { public: true })
    .add('/login', async ctx => (await pages.login()).render(renderShellless, { mode: 'login', ...ctx }), { public: true, guestOnly: true })
    .add('/signup', async ctx => (await pages.login()).render(renderShellless, { mode: 'signup', ...ctx }), { public: true, guestOnly: true })
    .add('/reset-password', async ctx => (await pages.login()).render(renderShellless, { mode: 'reset', ...ctx }), { public: true })
    .add('/auth/callback', async ctx => (await pages.login()).render(renderShellless, { mode: 'callback', ...ctx }), { public: true })
    .add('/app', async ctx => (await pages.home()).render(ctx))
    .add('/app/projects', async ctx => (await pages.projects()).render(ctx))
    .add('/app/projects/:id', async ctx => (await pages.project()).render(ctx))
    .add('/app/projects/:id/chat', async ctx => (await pages.workspace()).render(ctx))
    .add('/app/projects/:id/chat/:conversationId', async ctx => (await pages.workspace()).render(ctx))
    .add('/app/tasks', async ctx => (await pages.tasks()).render(ctx))
    .add('/app/tasks/:id', async ctx => (await pages.task()).render(ctx))
    .add('/app/settings', async ctx => (await pages.settings()).render(ctx))
    .add('/app/settings/:tab', async ctx => (await pages.settings()).render(ctx))
    .add('/admin', async ctx => (await pages.admin()).render(ctx), { admin: true })
    .add('/admin/:section', async ctx => (await pages.admin()).render(ctx), { admin: true })
    .notFound(async ctx => (await pages.notFound()).render(renderShellless, ctx));

  // A single guard runs before every navigation.
  router.onNavigate(async ({ route, params, query, pathname }) => {
    const session = store.state.session;
    const { public: isPublic, guestOnly, admin } = route.options;

    if (!isPublic && !session) {
      const next = encodeURIComponent(pathname + location.search);
      return router.navigate(`/login?next=${next}`, { replace: true });
    }
    if (guestOnly && session) return router.navigate('/app', { replace: true });
    if (admin && !session?.isPlatformAdmin) return router.navigate('/app', { replace: true });

    try {
      await route.load({ params, query, pathname });
    } catch (error) {
      console.error('route failed', error);
      toastError(error, 'This page could not be opened');
    }
  });
}

async function start() {
  restoreUi();
  registerRoutes();

  api.onEvent(event => {
    if (event === 'signed-out') {
      api.setToken('');
      store.reset();
      if (location.pathname.startsWith('/app') || location.pathname.startsWith('/admin')) {
        router.navigate('/login', { replace: true });
      }
    }
  });

  await bootSession();
  store.set({ ready: true });

  try {
    const health = await api.get('/health');
    store.set({ capabilities: health.capabilities || {} });
  } catch { /* the app still works; capability-gated UI stays disabled */ }

  await router.start();
}

start().catch(error => {
  console.error('boot failed', error);
  renderShellless(h('div.empty',
    h('h1.empty__title', 'DiroxCode could not start'),
    h('p.empty__body', error?.message || 'An unexpected error occurred while loading the application.'),
    h('button.btn.btn--primary', { onClick: () => location.reload() }, 'Reload')
  ));
});
