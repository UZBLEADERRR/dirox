/**
 * History-API router.
 *
 * Routes declare whether they need a session; the guard redirects rather than
 * flashing a protected screen. Page modules are imported lazily so the landing
 * page never downloads the workspace code.
 */

const routes = [];
let notFoundHandler = null;
let current = null;
let onNavigate = null;

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) { keys.push(segment.slice(1)); return '([^/]+)'; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

export const router = {
  add(pattern, load, options = {}) {
    routes.push({ pattern, ...compile(pattern), load, options });
    return this;
  },

  notFound(load) { notFoundHandler = load; return this; },
  onNavigate(fn) { onNavigate = fn; return this; },

  match(pathname) {
    for (const route of routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1] || ''); });
      return { route, params };
    }
    return null;
  },

  /** @param {string} to  path with optional query string */
  navigate(to, { replace = false, state = {} } = {}) {
    const url = new URL(to, location.origin);
    if (url.pathname === location.pathname && url.search === location.search && !replace) return;
    history[replace ? 'replaceState' : 'pushState'](state, '', url.pathname + url.search + url.hash);
    return this.resolve();
  },

  async resolve() {
    const pathname = location.pathname;
    const matched = this.match(pathname);
    const query = Object.fromEntries(new URLSearchParams(location.search));

    if (!matched) {
      current = { pathname };
      return notFoundHandler?.({ pathname, query });
    }

    current = { pathname, params: matched.params, route: matched.route };
    return onNavigate
      ? onNavigate({ ...matched, params: matched.params, query, pathname })
      : matched.route.load({ params: matched.params, query, pathname });
  },

  get current() { return current; },

  start() {
    window.addEventListener('popstate', () => this.resolve());

    // Intercept in-app links so anchors keep working without a full reload.
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('mailto:') || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      event.preventDefault();
      this.navigate(href);
    });

    return this.resolve();
  }
};

export function currentPath() { return location.pathname; }
