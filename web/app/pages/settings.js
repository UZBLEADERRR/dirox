/**
 * Profile and settings.
 *
 * Organised as a real product surface rather than a generic settings dump:
 * account, developer profile, AI behaviour, usage, security, billing,
 * notifications, and a clearly separated danger zone.
 */

import { h, icon, mount, debounce } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { renderInShell } from '../components/shell.js';
import { confirmModal, openModal } from '../components/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { formatCost, formatCents, formatTokens, formatNumber, relativeTime, formatDate, initials } from '../lib/format.js';

const TABS = [
  ['account', 'Account'],
  ['developer', 'Developer'],
  ['ai', 'AI behaviour'],
  ['usage', 'Usage'],
  ['billing', 'Billing'],
  ['security', 'Security'],
  ['notifications', 'Notifications'],
  ['danger', 'Danger zone']
];

/** A labelled row with a control on the right. */
function row(label, hint, control) {
  return h('div.setting-row',
    h('div', h('div.setting-row__label', label), hint ? h('p.setting-row__hint', hint) : null),
    h('div.setting-row__control', control)
  );
}

function switchControl(checked, onChange) {
  const element = h('button.switch', {
    role: 'switch',
    'aria-checked': String(Boolean(checked)),
    onClick: () => {
      const next = element.getAttribute('aria-checked') !== 'true';
      element.setAttribute('aria-checked', String(next));
      onChange(next);
    }
  });
  return element;
}

/** Saves are debounced and report themselves once, not per keystroke. */
function createSaver() {
  let pending = {};
  const flush = debounce(async () => {
    const patch = pending;
    pending = {};
    if (!Object.keys(patch).length) return;
    try {
      const { profile } = await api.patch('/me/profile', patch);
      const session = store.state.session;
      if (session) store.set({ session: { ...session, profile: { ...session.profile, ...camelize(profile) } } });
      toast.success('Saved.');
    } catch (error) {
      toastError(error, 'Could not save');
    }
  }, 700);

  return (patch) => { pending = { ...pending, ...patch }; flush(); };
}

function camelize(profile) {
  return {
    fullName: profile.full_name, username: profile.username, avatarUrl: profile.avatar_url,
    timezone: profile.timezone, locale: profile.locale, experienceLevel: profile.experience_level,
    primaryLanguages: profile.primary_languages, preferredFrameworks: profile.preferred_frameworks,
    aiPreferences: profile.ai_preferences, notificationPreferences: profile.notification_preferences
  };
}

// ─── panels ─────────────────────────────────────────────────────────────────

function accountPanel(save) {
  const session = store.state.session;
  const profile = session?.profile || {};

  return h('div.card',
    h('div.row', { style: { gap: 'var(--s-4)', paddingBottom: 'var(--s-5)', borderBottom: '1px solid var(--border)' } },
      h('span.avatar.avatar--lg', profile.avatarUrl
        ? h('img', { src: profile.avatarUrl, alt: '' })
        : initials(profile.fullName, session?.user?.email)),
      h('div',
        h('div', { style: { fontSize: 'var(--fs-lg)', fontWeight: '600', color: 'var(--text-strong)' } }, profile.fullName || 'Your name'),
        h('div.subtle', { style: { fontSize: 'var(--fs-sm)' } }, session?.user?.email || ''),
        session?.user?.emailVerified === false
          ? h('span.badge.badge--warning', { style: { marginTop: 'var(--s-2)' } }, 'Email not verified')
          : null
      )
    ),

    row('Name', 'How you appear across DiroxCode.',
      h('input.input', { value: profile.fullName || '', maxlength: '80', onInput: e => save({ fullName: e.target.value }) })),

    row('Username', 'Lowercase letters, numbers, dash and underscore.',
      h('input.input', { value: profile.username || '', maxlength: '32', placeholder: 'ada', onInput: e => save({ username: e.target.value.toLowerCase() }) })),

    row('Avatar URL', 'A link to an image, if you would rather not use initials.',
      h('input.input', { value: profile.avatarUrl || '', maxlength: '500', placeholder: 'https://…', onInput: e => save({ avatarUrl: e.target.value }) })),

    row('Timezone', 'Used for scheduling and daily limits.',
      h('input.input', { value: profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, maxlength: '60', onInput: e => save({ timezone: e.target.value }) })),

    row('Language', 'Interface language. More languages are being added.',
      h('select.select', { onChange: e => save({ locale: e.target.value }) },
        [['en', 'English'], ['uz', 'Oʻzbekcha'], ['ru', 'Русский'], ['ko', '한국어']].map(([value, label]) =>
          h('option', { value, selected: (profile.locale || 'en') === value }, label))))
  );
}

function developerPanel(save) {
  const profile = store.state.session?.profile || {};
  const languages = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin', 'Swift', 'C#', 'PHP', 'Ruby', 'C++'];
  const frameworks = ['Next.js', 'React', 'Vue', 'Nuxt', 'Angular', 'Svelte', 'Node.js', 'Django', 'FastAPI', 'Flask', 'Spring', 'Laravel', '.NET', 'Rails'];

  const chips = (options, selected, onChange) => {
    const chosen = new Set(selected || []);
    return h('div.row.row--wrap', { style: { gap: 'var(--s-2)', justifyContent: 'flex-end' } },
      options.map(option => {
        const chip = h('button.badge', {
          'aria-pressed': String(chosen.has(option)),
          style: chosen.has(option)
            ? { borderColor: 'var(--accent-line)', background: 'var(--accent-quiet)', color: 'var(--red-300)', cursor: 'pointer' }
            : { cursor: 'pointer' },
          onClick: () => {
            if (chosen.has(option)) chosen.delete(option); else chosen.add(option);
            const isOn = chosen.has(option);
            chip.setAttribute('aria-pressed', String(isOn));
            Object.assign(chip.style, isOn
              ? { borderColor: 'var(--accent-line)', background: 'var(--accent-quiet)', color: 'var(--red-300)' }
              : { borderColor: '', background: '', color: '' });
            onChange([...chosen]);
          }
        }, option);
        return chip;
      }));
  };

  return h('div.card',
    row('Experience level', 'DiroxCode adjusts how much it explains.',
      h('select.select', { onChange: e => save({ experienceLevel: e.target.value }) },
        [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced'], ['expert', 'Expert']].map(([value, label]) =>
          h('option', { value, selected: (profile.experienceLevel || 'intermediate') === value }, label)))),

    row('Primary languages', 'Used when a project could be written several ways.',
      chips(languages, profile.primaryLanguages, value => save({ primaryLanguages: value }))),

    row('Preferred frameworks', 'Considered when new code is scaffolded.',
      chips(frameworks, profile.preferredFrameworks, value => save({ preferredFrameworks: value })))
  );
}

function aiPanel(save) {
  const profile = store.state.session?.profile || {};
  const preferences = profile.aiPreferences || {};
  const update = patch => save({ aiPreferences: { ...preferences, ...patch } });

  // The model list is whatever an administrator has opened to users. If none
  // is open, the row does not appear at all rather than offering an empty
  // control.
  const modelRow = h('div');
  const renderModelRow = models => {
    if (!models.length) return mount(modelRow);
    mount(modelRow, row('Default model',
      'Which model answers unless a chat picks another. Automatic routes by how hard the request is, which is usually cheaper.',
      h('select.select', { onChange: e => update({ defaultModelId: e.target.value || null }) },
        h('option', { value: '', selected: !preferences.defaultModelId }, 'Automatic'),
        models.map(model => h('option', {
          value: model.id, selected: preferences.defaultModelId === model.id
        }, model.name)))));
  };

  renderModelRow(store.state.models);
  if (!store.state.models.length) {
    api.get('/me/models')
      .then(({ models, defaultModelId }) => { store.set({ models, defaultModelId }); renderModelRow(models); })
      .catch(() => { /* routing stays automatic */ });
  }

  return h('div',
    h('div.card',
      modelRow,

      row('Autonomy', 'How much DiroxCode does before asking. Deleting files, pushing to Git and touching production always ask, whatever you choose here.',
        h('select.select', { onChange: e => update({ autonomy: e.target.value }) },
          [['safe', 'Safe — ask before any change'],
           ['confirm', 'Confirm — edit freely, ask for anything riskier'],
           ['autonomous', 'Autonomous — edit and install without asking']].map(([value, label]) =>
            h('option', { value, selected: (preferences.autonomy || 'confirm') === value }, label)))),

      row('Response detail', 'How much DiroxCode writes back to you.',
        h('select.select', { onChange: e => update({ verbosity: e.target.value }) },
          [['concise', 'Concise'], ['balanced', 'Balanced'], ['detailed', 'Detailed']].map(([value, label]) =>
            h('option', { value, selected: (preferences.verbosity || 'concise') === value }, label)))),

      row('Reasoning effort', 'Higher effort costs more and helps only on genuinely hard problems.',
        h('select.select', { onChange: e => update({ reasoningLevel: e.target.value }) },
          [['auto', 'Automatic'], ['none', 'None'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].map(([value, label]) =>
            h('option', { value, selected: (preferences.reasoningLevel || 'auto') === value }, label)))),

      row('Budget per task', 'DiroxCode compresses context and stops retrying as it approaches this.',
        h('select.select', { onChange: e => update({ budgetMicros: Number(e.target.value) }) },
          [[25_000, '$0.025 — very frugal'], [50_000, '$0.05'], [100_000, '$0.10 — default'],
           [250_000, '$0.25'], [500_000, '$0.50'], [1_000_000, '$1.00 — generous']].map(([value, label]) =>
            h('option', { value: String(value), selected: (preferences.budgetMicros || 100_000) === value }, label))))
    ),

    h('div.card', { style: { marginTop: 'var(--s-4)' } },
      row('Run tests automatically', 'After changing code, run the project test suite and fix what breaks.',
        switchControl(preferences.autoTest !== false, value => update({ autoTest: value }))),

      row('Review changes automatically', 'Run an AI review over the diff before reporting back.',
        switchControl(preferences.autoReview === true, value => update({ autoReview: value }))),

      row('Commit automatically', 'Commit successful changes to the working branch. Pushing still asks.',
        switchControl(preferences.autoCommit === true, value => update({ autoCommit: value })))
    ),

    h('div.card', { style: { marginTop: 'var(--s-4)' } },
      row('Coding style', 'Anything you want DiroxCode to follow in every project.',
        h('textarea.textarea', {
          rows: '3', maxlength: '500', placeholder: 'Prefer named exports. No default exports. Keep functions under 40 lines.',
          value: preferences.codingStyle || '',
          onInput: e => update({ codingStyle: e.target.value })
        })))
  );
}

async function usagePanel() {
  const container = h('div', h('div.skeleton', { style: { height: '200px' } }));
  try {
    const usage = await api.get('/me/usage');
    const totals = usage.totals;

    const bars = usage.byDay.slice(-14);
    const peak = Math.max(1, ...bars.map(day => day.costMicros));

    mount(container,
      h('div.grid.grid--4', { style: { marginBottom: 'var(--s-5)' } },
        [['AI cost', formatCost(totals.costMicros)],
         ['Tokens', formatTokens(totals.inputTokens + totals.outputTokens)],
         ['Requests', formatNumber(totals.requests)],
         ['Tasks', formatNumber(usage.tasks)]].map(([label, value]) =>
          h('div.stat', h('div.stat__label', label), h('div.stat__value', value), h('div.stat__delta', 'last 30 days')))),

      bars.length ? h('div.card', { style: { marginBottom: 'var(--s-4)' } },
        h('div.eyebrow', { style: { marginBottom: 'var(--s-4)' } }, 'Daily AI cost'),
        h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '4px', height: '90px' } },
          bars.map(day => h('div', {
            title: `${day.day}: ${formatCost(day.costMicros)}`,
            style: {
              flex: '1',
              height: `${Math.max(3, (day.costMicros / peak) * 100)}%`,
              background: 'var(--accent)',
              opacity: '0.75',
              borderRadius: '2px 2px 0 0'
            }
          }))),
        h('div.row.row--between', { style: { marginTop: 'var(--s-2)', fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)' } },
          h('span', bars[0]?.day || ''), h('span', bars[bars.length - 1]?.day || ''))
      ) : null,

      usage.byModel.length ? h('div.card.card--flush',
        h('div.panel__head', h('span.panel__title', 'By model')),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Model'), h('th.num', 'Requests'), h('th.num', 'Tokens'), h('th.num', 'Cost'))),
          h('tbody', usage.byModel.map(model => h('tr',
            h('td.mono', model.model || 'unknown'),
            h('td.num', formatNumber(model.requests)),
            h('td.num', formatTokens(model.tokens)),
            h('td.num', formatCost(model.costMicros))
          )))
        ))
      ) : h('div.card.empty', h('p.empty__body', 'No AI usage recorded yet.'))
    );
  } catch (error) {
    mount(container, h('div.empty', h('p.empty__body', error.message)));
  }
  return container;
}

/** Choose a plan and hand off to hosted checkout. */
async function openPlanPicker(currentCode) {
  const body = h('div', h('div.skeleton', { style: { height: '160px' } }));
  const modal = openModal({ title: 'Change plan', wide: true, body });

  try {
    const { plans } = await api.get('/billing/plans');
    let interval = 'monthly';

    const intervalPicker = h('div.segmented', { style: { alignSelf: 'flex-start' } },
      [['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([value, label]) =>
        h('button.segmented__btn', {
          'aria-pressed': String(value === interval),
          onClick: () => {
            interval = value;
            for (const button of intervalPicker.children) {
              button.setAttribute('aria-pressed', String(button.textContent === label));
            }
            renderPlans();
          }
        }, label)));

    const list = h('div.grid.grid--2');

    function renderPlans() {
      mount(list, plans.map(item => {
        const price = interval === 'yearly' ? item.priceYearlyCents : item.priceMonthlyCents;
        const isCurrent = item.code === currentCode;
        const selfServe = price > 0;

        return h('div.card', { style: isCurrent ? { borderColor: 'var(--accent-line)' } : {} },
          h('div.row.row--between',
            h('div', { style: { fontWeight: '600', color: 'var(--text-strong)' } }, item.name),
            isCurrent ? h('span.badge.badge--accent', 'current') : null),
          h('div', { style: { fontSize: 'var(--fs-2xl)', fontWeight: '600', margin: 'var(--s-3) 0' } },
            price ? formatCents(price) : 'Custom',
            price ? h('span.subtle', { style: { fontSize: 'var(--fs-xs)', fontWeight: '400' } },
              interval === 'yearly' ? ' / year' : ' / month') : null),
          h('p.subtle', { style: { fontSize: 'var(--fs-xs)', minHeight: '2.6em' } }, item.description),
          isCurrent
            ? h('button.btn.btn--block', { disabled: true }, 'Current plan')
            : selfServe
              ? h('button.btn.btn--primary.btn--block', {
                  onClick: async event => {
                    event.currentTarget.disabled = true;
                    try {
                      const { url } = await api.post('/billing/checkout', { planCode: item.code, interval });
                      location.href = url;
                    } catch (error) {
                      toastError(error, 'Checkout could not be started');
                      event.currentTarget.disabled = false;
                    }
                  }
                }, `Switch to ${item.name}`)
              : h('a.btn.btn--block', { href: '/contact' }, 'Contact us')
        );
      }));
    }

    mount(body, h('div.stack', intervalPicker, list));
    renderPlans();
  } catch (error) {
    mount(body, h('div.empty', h('p.empty__body', error.message)));
  }
}

async function billingPanel() {
  const container = h('div', h('div.skeleton', { style: { height: '180px' } }));

  // Hosted checkout returns here with a status. Report it honestly: the
  // subscription is only real once the webhook has been processed.
  const params = new URLSearchParams(location.search);
  if (params.get('checkout') === 'success') {
    toast.success('Payment received. Your plan updates as soon as the confirmation arrives.');
    history.replaceState({}, '', '/app/settings/billing');
  } else if (params.get('checkout') === 'cancelled') {
    toast('Checkout cancelled. Nothing was charged.');
    history.replaceState({}, '', '/app/settings/billing');
  }

  try {
    const data = await api.get('/billing/subscription');
    const { plan, subscription, usage, limits } = data;

    const meter = (label, used, limit) => {
      if (limit === null || limit === undefined) {
        return row(label, 'Unlimited on this plan', h('span.badge.badge--success', 'unlimited'));
      }
      const ratio = Math.min(1, used / limit);
      return h('div.setting-row',
        h('div', { style: { flex: '1' } },
          h('div.setting-row__label', label),
          h('p.setting-row__hint', `${formatNumber(used)} of ${formatNumber(limit)}`),
          h('div.progress', { style: { marginTop: 'var(--s-2)', maxWidth: '320px' } },
            h('div.progress__bar', {
              class: ratio > 0.9 ? '' : ratio > 0.7 ? 'progress__bar--warning' : 'progress__bar--success',
              style: { width: `${ratio * 100}%` }
            }))
        )
      );
    };

    mount(container,
      h('div.card', { style: { marginBottom: 'var(--s-4)' } },
        h('div.row.row--between', { style: { paddingBottom: 'var(--s-4)', borderBottom: '1px solid var(--border)' } },
          h('div',
            h('div.eyebrow', 'Current plan'),
            h('div', { style: { fontSize: 'var(--fs-xl)', fontWeight: '600', color: 'var(--text-strong)', marginTop: 'var(--s-1)' } }, plan.name),
            h('div.subtle', { style: { fontSize: 'var(--fs-sm)' } },
              plan.priceMonthlyCents ? `${formatCents(plan.priceMonthlyCents)} / month` : 'Free'),
            subscription?.periodEnd
              ? h('div.subtle', { style: { fontSize: 'var(--fs-2xs)', marginTop: 'var(--s-2)' } },
                  `${subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatDate(subscription.periodEnd)}`)
              : null
          ),
          data.paymentsEnabled
            ? h('div.row',
                subscription?.status === 'active' || subscription?.status === 'past_due'
                  ? h('button.btn', {
                      onClick: async event => {
                        event.currentTarget.disabled = true;
                        try {
                          const { url } = await api.post('/billing/portal', {});
                          location.href = url;
                        } catch (error) {
                          toastError(error, 'Billing portal unavailable');
                          event.currentTarget.disabled = false;
                        }
                      }
                    }, 'Manage billing')
                  : null,
                h('button.btn.btn--primary', { onClick: () => openPlanPicker(plan.code) }, 'Change plan'))
            : h('span.badge', 'Payments not configured')
        ),

        meter('Projects', usage.projects, limits.projects),
        meter('Tasks today', usage.tasksToday, limits.tasksPerDay),
        meter('Tokens this period', usage.totalTokens, limits.tokensPerMonth),
        meter('Concurrent agents', usage.runningAgents, limits.concurrentAgents)
      ),

      h('div.card',
        h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'This period'),
        h('dl.meta-list',
          h('div.meta-row', h('dt.meta-row__label', 'AI cost'), h('dd.meta-row__value', formatCost(usage.costMicros))),
          h('div.meta-row', h('dt.meta-row__label', 'Requests'), h('dd.meta-row__value', formatNumber(usage.requests))),
          h('div.meta-row', h('dt.meta-row__label', 'Tasks'), h('dd.meta-row__value', formatNumber(usage.tasks))),
          subscription?.creditsCents
            ? h('div.meta-row', h('dt.meta-row__label', 'Credit remaining'), h('dd.meta-row__value', formatCents(subscription.creditsCents)))
            : null
        ))
    );
  } catch (error) {
    mount(container, h('div.empty', h('p.empty__body', error.message)));
  }
  return container;
}

async function securityPanel() {
  const container = h('div', h('div.skeleton', { style: { height: '200px' } }));

  const passwordCard = h('div.card',
    row('Password', 'Choose a new password. You stay signed in on this device.',
      h('button.btn', {
        onClick: () => {
          const input = h('input.input', { type: 'password', minlength: '8', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
          const modal = confirmModal({
            title: 'Change password',
            message: 'Enter a new password of at least 8 characters.',
            confirmLabel: 'Update password',
            danger: false,
            onConfirm: async () => {
              if (input.value.length < 8) { toast.error('Password must be at least 8 characters.'); throw new Error('too short'); }
              await api.post('/auth/password/update', { password: input.value });
              toast.success('Password updated.');
            }
          });
          modal.element.querySelector('.modal__body').appendChild(h('div.field', { style: { marginTop: 'var(--s-3)' } }, input));
        }
      }, 'Change password'))
  );

  try {
    const [{ sessions }, { events }, github] = await Promise.all([
      api.get('/me/sessions').catch(() => ({ sessions: [] })),
      api.get('/me/security-events').catch(() => ({ events: [] })),
      api.get('/github/status').catch(() => null)
    ]);

    mount(container,
      passwordCard,

      github ? h('div.card', { style: { marginTop: 'var(--s-4)' } },
        row('GitHub', github.connected
          ? `Connected as ${github.account?.login}. The token stays on the server.`
          : github.available ? 'Not connected.' : 'Not configured on this deployment.',
          github.connected
            ? h('button.btn.btn--danger.btn--sm', {
                onClick: async () => { await api.delete('/github/connect'); toast('GitHub disconnected.'); render({ params: { tab: 'security' } }); }
              }, 'Disconnect')
            : github.available
              ? h('button.btn.btn--sm', {
                  onClick: async () => {
                    const { url } = await api.post('/github/connect', { returnTo: '/app/settings/security' });
                    location.href = url;
                  }
                }, 'Connect')
              : h('span.badge', 'unavailable'))
      ) : null,

      sessions.length ? h('div.card.card--flush', { style: { marginTop: 'var(--s-4)' } },
        h('div.panel__head', h('span.panel__title', 'Active sessions')),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Device'), h('th', 'IP'), h('th', 'Last active'), h('th', ''))),
          h('tbody', sessions.map(session => h('tr',
            h('td', session.device || session.user_agent?.slice(0, 40) || 'Unknown'),
            h('td.mono', session.ip || '—'),
            h('td', relativeTime(session.last_active_at)),
            h('td', session.revoked_at
              ? h('span.badge', 'revoked')
              : h('button.btn.btn--ghost.btn--sm', {
                  onClick: async () => { await api.delete(`/me/sessions/${session.id}`); toast('Session revoked.'); render({ params: { tab: 'security' } }); }
                }, 'Revoke'))
          )))
        ))
      ) : null,

      events.length ? h('div.card.card--flush', { style: { marginTop: 'var(--s-4)' } },
        h('div.panel__head', h('span.panel__title', 'Recent security events')),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Event'), h('th', 'IP'), h('th', 'When'))),
          h('tbody', events.slice(0, 20).map(event => h('tr',
            h('td', h('span.badge', { class: event.severity === 'critical' ? 'badge--danger' : event.severity === 'warning' ? 'badge--warning' : '' }, event.action)),
            h('td.mono', event.ip || '—'),
            h('td', relativeTime(event.created_at))
          )))
        ))
      ) : null
    );
  } catch (error) {
    mount(container, passwordCard, h('div.empty', h('p.empty__body', error.message)));
  }
  return container;
}

function notificationsPanel(save) {
  const preferences = store.state.session?.profile?.notificationPreferences || {};
  const update = patch => save({ notificationPreferences: { ...preferences, ...patch } });

  const items = [
    ['task_completed', 'Task completed', 'When DiroxCode finishes a task.'],
    ['task_failed', 'Task failed', 'When a task stops without completing.'],
    ['approval_required', 'Approval required', 'When the agent is waiting on you.'],
    ['security', 'Security alerts', 'Sign-ins, password changes, token changes.'],
    ['billing', 'Billing', 'Limits, invoices and plan changes.']
  ];

  return h('div.card', items.map(([key, label, hint]) =>
    row(label, hint, switchControl(preferences[key] !== false, value => update({ [key]: value })))));
}

function dangerPanel() {
  const email = store.state.session?.user?.email || '';

  return h('div.card.danger-zone',
    row('Export your data', 'Download your profile, projects, tasks, conversations and memory as JSON.',
      h('button.btn', {
        onClick: async () => {
          try {
            const data = await api.get('/me/export');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = h('a', { href: url, download: `diroxcode-export-${Date.now()}.json` });
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            toast.success('Export downloaded.');
          } catch (error) { toastError(error, 'Export failed'); }
        }
      }, 'Export data')),

    row('Delete account', 'Removes your account, your personal organization and everything in it. This cannot be undone.',
      h('button.btn.btn--danger', {
        onClick: () => confirmModal({
          title: 'Delete your account?',
          message: 'Your projects, tasks, conversations and memory will be permanently removed. Connected GitHub repositories are not affected.',
          confirmLabel: 'Delete my account',
          requirePhrase: email,
          onConfirm: async () => {
            await api.post('/me/delete-account', { confirmEmail: email });
            api.setToken('');
            store.reset();
            router.navigate('/', { replace: true });
            toast('Your account has been deleted.');
          }
        })
      }, 'Delete account'))
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

export async function render({ params = {} } = {}) {
  const active = TABS.some(([id]) => id === params.tab) ? params.tab : 'account';
  const content = h('div.view__inner.view__inner--narrow');
  renderInShell(content, { title: 'Settings', crumbs: [['Settings', null]] });

  const save = createSaver();
  const panel = h('div');

  const nav = h('nav.settings__nav', { 'aria-label': 'Settings sections' },
    TABS.map(([id, label]) => h('a.settings__link', {
      href: `/app/settings/${id}`,
      'aria-current': id === active ? 'page' : null,
      style: id === 'danger' ? { color: 'var(--danger)' } : {}
    }, label)));

  mount(content,
    h('div.page-head',
      h('h1.page-head__title', 'Settings'),
      h('p.page-head__sub', 'Your profile, how DiroxCode behaves, and what it is costing you.')
    ),
    h('div.settings', nav, panel)
  );

  const panels = {
    account: () => accountPanel(save),
    developer: () => developerPanel(save),
    ai: () => aiPanel(save),
    usage: usagePanel,
    billing: billingPanel,
    security: securityPanel,
    notifications: () => notificationsPanel(save),
    danger: dangerPanel
  };

  const result = panels[active]();
  if (result instanceof Promise) {
    mount(panel, h('div.skeleton', { style: { height: '220px' } }));
    mount(panel, await result);
  } else {
    mount(panel, result);
  }
}
