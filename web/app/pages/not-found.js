import { h } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { wordmark } from '../components/brand.js';

export async function render(renderTo, { pathname } = {}) {
  const signedIn = Boolean(store.state.session);
  renderTo(h('div', { style: { minHeight: '100dvh', display: 'grid', placeContent: 'center', gap: 'var(--s-6)', padding: 'var(--s-6)', textAlign: 'center', justifyItems: 'center' } },
    wordmark(),
    h('h1', { style: { fontSize: 'var(--fs-4xl)' } }, 'Page not found'),
    h('p.muted', { style: { maxWidth: '44ch' } },
      `Nothing lives at ${pathname || 'that address'}. It may have been moved or the link may be out of date.`),
    h('a.btn.btn--primary', { href: signedIn ? '/app' : '/' }, signedIn ? 'Back to DiroxCode' : 'Back to the homepage')
  ));
}
