/**
 * Sign in, sign up, password reset and the OAuth callback.
 *
 * Access tokens live in memory; the refresh token is set by the server as an
 * HttpOnly cookie. Nothing durable is written to localStorage.
 */

import { h, icon, mount, qs } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { toast, toastError } from '../lib/toast.js';
import { wordmark } from '../components/brand.js';

const POINTS = [
  'Connect a repository and ask for what you want built.',
  'Only the code that matters reaches the model.',
  'Tests run, failures get fixed, changes get reviewed.',
  'Every change is checkpointed and reversible.'
];

function aside() {
  return h('aside.auth__aside',
    wordmark(),
    h('div',
      h('p.auth__quote', 'Describe the task. ', h('em', 'DiroxCode does the engineering'), '.'),
      h('ul.auth__points', { style: { marginTop: 'var(--s-8)' } },
        POINTS.map(point => h('li', icon('check', { size: 14 }), h('span', point))))
    ),
    h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'Secure by default. Your provider keys never reach the browser.')
  );
}

function oauthButtons(disabled, next) {
  const providers = [['github', 'Continue with GitHub'], ['google', 'Continue with Google']];
  const query = next && next !== '/app' ? `?next=${encodeURIComponent(next)}` : '';

  return h('div.stack--tight', { class: 'stack' },
    providers.map(([provider, label]) => h('a.btn.btn--block', {
      href: disabled ? null : `/api/auth/oauth/${provider}${query}`,
      // A real browser navigation to a server endpoint, not a client route.
      'data-native': true,
      'aria-disabled': disabled ? 'true' : null,
      style: disabled ? { opacity: '.45', pointerEvents: 'none' } : {},
      onClick: disabled ? event => event.preventDefault() : null
    }, label))
  );
}

/** Reasons the OAuth round trip can come back without a session. */
const OAUTH_ERRORS = {
  app_url_missing: 'Social sign-in is not finished being set up on this deployment: APP_URL is not configured, so the provider has nowhere to send you back to.',
  auth_not_configured: 'This deployment has no authentication service configured yet.',
  unsupported_provider: 'That sign-in provider is not supported.'
};

async function finishSignIn(session, nextPath) {
  api.setToken(session.accessToken);
  const me = await api.get('/auth/me');
  api.setOrg(me.organization?.id || '');
  store.set({ session: me });
  router.navigate(nextPath || '/app', { replace: true });
}

function loginForm({ next }) {
  const state = { busy: false };
  const errorSlot = h('div');

  const submit = async event => {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    mount(button, h('span.btn__spinner'), 'Signing in…');
    mount(errorSlot);

    try {
      const data = new FormData(event.target);
      const session = await api.post('/auth/login', {
        email: String(data.get('email') || ''),
        password: String(data.get('password') || '')
      });
      await finishSignIn(session, next);
    } catch (error) {
      mount(errorSlot, h('p.field__error', { role: 'alert' }, error.message));
      state.busy = false;
      button.disabled = false;
      mount(button, 'Sign in');
    }
  };

  const button = h('button.btn.btn--primary.btn--block.btn--lg', { type: 'submit' }, 'Sign in');

  return h('form.stack', { onSubmit: submit, novalidate: true },
    h('div.field',
      h('label.label', { for: 'email' }, 'Email'),
      h('input#email.input', { name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com' })
    ),
    h('div.field',
      h('div.row.row--between',
        h('label.label', { for: 'password' }, 'Password'),
        h('a', { href: '/reset-password', style: { fontSize: 'var(--fs-xs)', color: 'var(--text-subtle)' } }, 'Forgot?')
      ),
      h('input#password.input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: '••••••••' })
    ),
    errorSlot,
    button
  );
}

function signupForm({ next }) {
  const errorSlot = h('div');
  const button = h('button.btn.btn--primary.btn--block.btn--lg', { type: 'submit' }, 'Create account');
  let busy = false;

  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    button.disabled = true;
    mount(button, h('span.btn__spinner'), 'Creating…');
    mount(errorSlot);

    try {
      const data = new FormData(event.target);
      const result = await api.post('/auth/signup', {
        email: String(data.get('email') || ''),
        password: String(data.get('password') || ''),
        fullName: String(data.get('fullName') || '')
      });

      if (result.emailVerificationRequired) {
        mount(qs('.auth__form'),
          h('h1.auth__title', 'Check your inbox'),
          h('p.auth__sub', `We sent a confirmation link to ${result.user?.email || 'your email address'}. Open it to finish setting up your account.`),
          h('a.btn.btn--block', { href: '/login' }, 'Back to sign in')
        );
        return;
      }
      await finishSignIn(result, next);
      toast.success('Welcome to DiroxCode.');
    } catch (error) {
      mount(errorSlot, h('p.field__error', { role: 'alert' }, error.message));
      busy = false;
      button.disabled = false;
      mount(button, 'Create account');
    }
  };

  return h('form.stack', { onSubmit: submit, novalidate: true },
    h('div.field',
      h('label.label', { for: 'fullName' }, 'Name'),
      h('input#fullName.input', { name: 'fullName', type: 'text', autocomplete: 'name', maxlength: '80', placeholder: 'Ada Lovelace' })
    ),
    h('div.field',
      h('label.label', { for: 'email' }, 'Email'),
      h('input#email.input', { name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com' })
    ),
    h('div.field',
      h('label.label', { for: 'password' }, 'Password'),
      h('input#password.input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: '8', placeholder: 'At least 8 characters' }),
      h('p.field__hint', 'Use at least 8 characters.')
    ),
    errorSlot,
    button,
    h('p.field__hint', { style: { textAlign: 'center' } },
      'By creating an account you agree to keep your provider credentials in server configuration, never in the browser.')
  );
}

function resetForm() {
  const slot = h('div');
  const button = h('button.btn.btn--primary.btn--block.btn--lg', { type: 'submit' }, 'Send reset link');

  const submit = async event => {
    event.preventDefault();
    button.disabled = true;
    try {
      const data = new FormData(event.target);
      const result = await api.post('/auth/password/reset', { email: String(data.get('email') || '') });
      mount(slot, h('p.field__hint', { role: 'status' }, result.message));
    } catch (error) {
      mount(slot, h('p.field__error', { role: 'alert' }, error.message));
    } finally {
      button.disabled = false;
    }
  };

  return h('form.stack', { onSubmit: submit, novalidate: true },
    h('div.field',
      h('label.label', { for: 'email' }, 'Email'),
      h('input#email.input', { name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com' })
    ),
    slot,
    button
  );
}

/** Supabase returns the session in the URL fragment after an OAuth redirect. */
async function handleCallback(next) {
  // The destination was carried through the provider as a query parameter.
  const carried = new URLSearchParams(location.search).get('next');
  if (carried?.startsWith('/')) next = carried;

  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get('access_token');
  const errorDescription = params.get('error_description');

  history.replaceState({}, '', location.pathname);

  if (errorDescription) {
    toastError({ message: errorDescription }, 'Sign-in failed');
    return router.navigate('/login', { replace: true });
  }
  if (!accessToken) return router.navigate('/login', { replace: true });

  try {
    await finishSignIn({ accessToken }, next);
  } catch (error) {
    toastError(error, 'Sign-in could not be completed');
    router.navigate('/login', { replace: true });
  }
}

export async function render(renderTo, { mode = 'login', query = {} } = {}) {
  const next = query.next ? decodeURIComponent(query.next) : '/app';
  const dbReady = store.state.capabilities?.database !== false;

  if (mode === 'callback') {
    renderTo(h('div.boot', h('div.boot__mark'), h('p.boot__text', 'Completing sign-in…')));
    return handleCallback(next);
  }

  const copy = {
    login: ['Sign in', 'Continue where you left off.'],
    signup: ['Create your account', 'Connect a project and give DiroxCode its first task.'],
    reset: ['Reset your password', 'We will email you a link to choose a new one.']
  }[mode];

  const form = mode === 'signup' ? signupForm({ next }) : mode === 'reset' ? resetForm() : loginForm({ next });

  // A failed OAuth attempt comes back as ?error=<reason>.
  const oauthError = query.error ? (OAUTH_ERRORS[query.error] || 'Sign-in did not complete. Please try again.') : null;
  if (query.error) history.replaceState({}, '', location.pathname);

  renderTo(h('div.auth',
    aside(),
    h('main.auth__main', { id: 'main' },
      h('div.auth__form',
        h('div', { style: { marginBottom: 'var(--s-8)' } }, wordmark({ size: 24 })),
        h('h1.auth__title', copy[0]),
        h('p.auth__sub', copy[1]),

        oauthError ? h('div.auth__notice', { role: 'alert' }, oauthError) : null,

        dbReady ? null : h('div.auth__notice', { role: 'status' },
          'This deployment has no database configured yet. Set SUPABASE_URL and SUPABASE_ANON_KEY on the server to enable accounts.'),

        mode === 'reset' ? null : oauthButtons(!dbReady, next),
        mode === 'reset' ? null : h('div.auth__divider', 'or'),
        form,

        h('p.auth__foot',
          mode === 'signup'
            ? h('span', 'Already have an account? ', h('a', { href: '/login' }, 'Sign in'))
            : mode === 'reset'
              ? h('a', { href: '/login' }, 'Back to sign in')
              : h('span', 'New to DiroxCode? ', h('a', { href: '/signup' }, 'Create an account'))
        )
      )
    )
  ));
}
