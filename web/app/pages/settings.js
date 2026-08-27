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
  ['automation', 'Automation'],
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

  // A picture is a file people have, not a URL they can produce. Asking for a
  // link meant uploading it somewhere else first.
  const avatarImage = h('span.avatar.avatar--lg', profile.avatarUrl
    ? h('img', { src: profile.avatarUrl, alt: '' })
    : initials(profile.fullName, session?.user?.email));

  const avatarPicker = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true,
    onChange: async event => {
      const [file] = event.target.files || [];
      event.target.value = '';
      if (!file) return;
      try {
        const { avatarUrl } = await api.upload('/me/avatar', file);
        mount(avatarImage, h('img', { src: avatarUrl, alt: '' }));
        const current = store.state.session;
        if (current) store.set({ session: { ...current, profile: { ...current.profile, avatarUrl } } });
        toast.success('Profile picture updated.');
      } catch (error) {
        toastError(error, 'That picture could not be uploaded');
      }
    }
  });

  return h('div.card',
    h('div.row', { style: { gap: 'var(--s-4)', paddingBottom: 'var(--s-5)', borderBottom: '1px solid var(--border)' } },
      h('button.avatar-edit', {
        type: 'button',
        title: 'Change your picture',
        'aria-label': 'Change your picture',
        onClick: () => avatarPicker.click()
      }, avatarImage, h('span.avatar-edit__hint', 'Change')),
      avatarPicker,
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

    row('Profile picture', 'PNG, JPEG, WebP or GIF, up to 4MB. Click the picture above to change it.',
      h('div.row',
        h('button.btn.btn--sm', { onClick: () => avatarPicker.click() }, 'Upload a picture'),
        profile.avatarUrl
          ? h('button.btn.btn--ghost.btn--sm', {
              onClick: async () => {
                await save({ avatarUrl: '' });
                mount(avatarImage, initials(profile.fullName, session?.user?.email));
              }
            }, 'Remove')
          : null)),

    row('Timezone', 'Used for scheduling and daily limits.',
      h('input.input', { value: profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, maxlength: '60', onInput: e => save({ timezone: e.target.value }) })),

    row('Language', 'Interface language. More languages are being added.',
      h('select.select', { onChange: e => save({ locale: e.target.value }) },
        [['en', 'English'], ['uz', 'Oʻzbekcha'], ['ru', 'Русский'], ['ko', '한국어']].map(([value, label]) =>
          h('option', { value, selected: (profile.locale || 'en') === value }, label))))
  );
}

/**
 * Connecting a Supabase project.
 *
 * Credentials are pasted, so the panel says plainly what each one unlocks and
 * shows only what is connected afterwards — never the key back.
 */
function supabasePanel() {
  const container = h('div.card', h('div.skeleton', { style: { height: '120px' } }));

  const render = state => {
    if (state?.connected) {
      return mount(container,
        h('div.row.row--between', { style: { marginBottom: 'var(--s-4)' } },
          h('div',
            h('div', { style: { fontWeight: '600', color: 'var(--text-strong)' } }, `Supabase · ${state.ref}`),
            h('div.subtle', { style: { fontSize: 'var(--fs-xs)' } }, state.projectUrl)),
          h('span.badge.badge--success', 'connected')),

        h('div.stack--tight', { class: 'stack', style: { marginBottom: 'var(--s-4)' } },
          h('div.subtle', { style: { fontSize: 'var(--fs-sm)' } },
            state.canRunSql
              ? `SQL and migrations${state.database ? ` against "${state.database}"` : ''}.`
              : 'No database connection string — DiroxCode can read data but cannot run migrations.'),
          h('div.subtle', { style: { fontSize: 'var(--fs-sm)' } },
            state.canUseRest ? 'REST API available.' : 'No service key.')),

        h('button.btn.btn--danger.btn--sm', {
          onClick: async () => {
            if (!await confirmModal({
              title: 'Disconnect Supabase?',
              body: 'DiroxCode will no longer be able to read or change that database. The project itself is untouched.',
              confirmLabel: 'Disconnect'
            })) return;
            await api.delete('/integrations/supabase');
            load();
          }
        }, 'Disconnect'));
    }

    const fields = {
      projectUrl: h('input.input', { placeholder: 'https://abcdefgh.supabase.co', autocomplete: 'off' }),
      serviceKey: h('input.input.input--mono', { type: 'password', placeholder: 'service_role key', autocomplete: 'off' }),
      connectionString: h('input.input.input--mono', { type: 'password', placeholder: 'postgresql://postgres:…@…:5432/postgres', autocomplete: 'off' })
    };

    const connect = h('button.btn.btn--primary', {
      onClick: async () => {
        connect.disabled = true;
        try {
          await api.post('/integrations/supabase', {
            projectUrl: fields.projectUrl.value.trim(),
            serviceKey: fields.serviceKey.value.trim(),
            connectionString: fields.connectionString.value.trim()
          });
          toast.success('Supabase connected.');
          load();
        } catch (error) {
          toastError(error, 'That connection could not be made');
          connect.disabled = false;
        }
      }
    }, 'Connect');

    mount(container,
      h('p.muted', { style: { fontSize: 'var(--fs-sm)', marginTop: '0' } },
        'Connect your own Supabase project and DiroxCode can read its schema, query it, and apply migrations — ' +
        'so an application it builds has a database, without you pasting SQL into a dashboard between every change.'),

      h('div.field', h('label.label', 'Project URL'), fields.projectUrl,
        h('p.field__hint', 'Settings → API in your Supabase dashboard.')),

      h('div.field', h('label.label', 'Service role key ',
        h('span.label__optional', '— optional')), fields.serviceKey,
        h('p.field__hint', 'Lets DiroxCode read and write rows. Stored encrypted and never shown again.')),

      h('div.field', h('label.label', 'Database connection string ',
        h('span.label__optional', '— optional')), fields.connectionString,
        h('p.field__hint', 'Settings → Database → Connection string. Required for migrations and schema changes.')),

      h('div.row', { style: { marginTop: 'var(--s-4)' } }, connect));
  };

  async function load() {
    try {
      const { supabase } = await api.get('/integrations/supabase');
      render(supabase);
    } catch (error) {
      mount(container, h('p.field__error', error.message));
    }
  }

  load();
  return container;
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

  return h('div',
    h('h2.section__title', { style: { marginBottom: 'var(--s-3)' } }, 'Supabase'),
    supabasePanel(),

    h('h2.section__title', { style: { margin: 'var(--s-8) 0 var(--s-3)' } }, 'Preferences'),
    h('div.card',
    row('Experience level', 'DiroxCode adjusts how much it explains.',
      h('select.select', { onChange: e => save({ experienceLevel: e.target.value }) },
        [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced'], ['expert', 'Expert']].map(([value, label]) =>
          h('option', { value, selected: (profile.experienceLevel || 'intermediate') === value }, label)))),

    row('Primary languages', 'Used when a project could be written several ways.',
      chips(languages, profile.primaryLanguages, value => save({ primaryLanguages: value }))),

    row('Preferred frameworks', 'Considered when new code is scaffolded.',
      chips(frameworks, profile.preferredFrameworks, value => save({ preferredFrameworks: value })))
    )
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
      /*
         On by default, and off for anybody who would rather not be asked.

         The plan is the cheapest moment to disagree — nothing written, nothing
         spent past the planning call — which is why it asks. But being stopped
         every time is its own cost, and somebody who has decided they do not
         want that should not have to decide it again on every task.
      */
      row('Show the plan before starting', 'DiroxCode plans a substantial change and waits for you to say go. Turn this off and it starts straight away.',
        switchControl(preferences.confirmPlan !== false, value => update({ confirmPlan: value }))),

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


/**
 * Automations.
 *
 * A schedule is a task waiting for a time, so the form asks for the same
 * things a task does plus when. Two of them earn their place:
 *
 *   The preview. A weekly schedule that turns out to be daily is expensive,
 *   and cron is famously easy to mean the opposite of. Showing the next five
 *   runs before it is saved is cheaper than finding out on the bill.
 *
 *   The trust picker, which is the only field here that is a security
 *   decision. Nobody is present when this runs, so what it may do without
 *   asking is chosen once, deliberately, by a person.
 */
function automationPanel() {
  const container = h('div.stack');

  const listCard = h('div.card', h('div.skeleton', { style: { height: '120px' } }));

  const fields = {
    name: h('input.input', { placeholder: 'Weekly dependency check' }),
    objective: h('textarea.input', {
      rows: '3',
      placeholder: 'Check every dependency for a newer version. Open a pull request for the safe ones and list the rest.'
    }),
    cron: h('input.input.input--mono', { placeholder: '0 9 * * mon', value: '0 9 * * mon' }),
    timezone: h('input.input', { placeholder: 'Asia/Tashkent', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
    project: h('select.select'),
    mode: h('select.select', [['agent', 'Agent'], ['ask', 'Ask'], ['review', 'Review'], ['debug', 'Debug'], ['autopilot', 'Autopilot']]
      .map(([value, label]) => h('option', { value }, label))),
    trust: h('select.select', [
      ['safe', 'Ask before any change'],
      ['confirm', 'Edit files, ask for anything riskier'],
      ['autonomous', 'Edit and install without asking']
    ].map(([value, label]) => h('option', { value }, label)))
  };
  fields.trust.value = 'confirm';

  const preview = h('p.subtle', { style: { fontSize: 'var(--fs-xs)', minHeight: '2.4em' } },
    'Enter a schedule to see when it would run.');

  /** What this expression actually means, from the server that will run it. */
  let previewTimer = null;
  const refreshPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        const result = await api.post('/schedules/preview', {
          cron: fields.cron.value.trim(),
          timezone: fields.timezone.value.trim() || 'UTC'
        });
        mount(preview,
          h('span', { style: { color: 'var(--text)' } }, result.description),
          h('br'),
          `Next: ${result.nextRuns.slice(0, 3).map(when => new Date(when).toLocaleString()).join(' · ')}`);
      } catch (error) {
        mount(preview, h('span', { style: { color: 'var(--danger)' } }, error.message));
      }
    }, 250);
  };
  fields.cron.addEventListener('input', refreshPreview);
  fields.timezone.addEventListener('input', refreshPreview);

  async function load() {
    try {
      const { schedules } = await api.get('/schedules');
      renderList(schedules);
    } catch (error) {
      mount(listCard, h('p.field__error', error.message));
    }
  }

  function renderList(schedules) {
    if (!schedules.length) {
      return mount(listCard,
        h('div.empty',
          h('div.empty__title', 'Nothing runs on its own yet'),
          h('p.empty__body', 'A schedule runs a task at a set time with nobody watching — a weekly dependency check, a nightly report, a morning triage.')));
    }

    mount(listCard, h('div.schedules', schedules.map(schedule =>
      h('div.schedule', { 'data-enabled': String(schedule.enabled) },
        h('div.schedule__what',
          h('div.schedule__name', schedule.name),
          h('div.schedule__when', schedule.description),
          h('div.schedule__meta',
            [
              schedule.enabled && schedule.nextRunAt ? `next ${new Date(schedule.nextRunAt).toLocaleString()}` : 'paused',
              schedule.runCount ? `${schedule.runCount} run(s)` : null,
              schedule.lastStatus ? `last ${schedule.lastStatus}` : null,
              schedule.consecutiveFailures >= 3 ? `${schedule.consecutiveFailures} failures in a row` : null
            ].filter(Boolean).join(' · '))),

        h('div.schedule__actions',
          h('button.btn.btn--sm', {
            title: 'Run it now without moving its schedule',
            onClick: async event => {
              event.target.disabled = true;
              try {
                const { streamUrl } = await api.post(`/schedules/${schedule.id}/run`, {});
                toast(`Started. Follow it in Tasks.${streamUrl ? '' : ''}`);
              } catch (error) { toastError(error); }
              finally { event.target.disabled = false; }
            }
          }, 'Run now'),
          h('button.btn.btn--sm', {
            onClick: async () => {
              try {
                await api.patch(`/schedules/${schedule.id}`, { enabled: !schedule.enabled });
                load();
              } catch (error) { toastError(error); }
            }
          }, schedule.enabled ? 'Pause' : 'Resume'),
          h('button.btn.btn--danger.btn--sm', {
            onClick: async () => {
              if (!await confirmModal({
                title: `Delete "${schedule.name}"?`,
                body: 'It will stop running. Tasks it has already produced are kept.',
                confirmLabel: 'Delete'
              })) return;
              try { await api.delete(`/schedules/${schedule.id}`); load(); }
              catch (error) { toastError(error); }
            }
          }, 'Delete')))
    )));
  }

  const create = h('button.btn.btn--primary', {
    onClick: async () => {
      create.disabled = true;
      try {
        await api.post('/schedules', {
          name: fields.name.value.trim(),
          objective: fields.objective.value.trim(),
          cron: fields.cron.value.trim(),
          timezone: fields.timezone.value.trim() || 'UTC',
          mode: fields.mode.value,
          trust: fields.trust.value,
          projectId: fields.project.value || undefined
        });
        fields.name.value = '';
        fields.objective.value = '';
        toast('Scheduled.');
        load();
      } catch (error) { toastError(error); }
      finally { create.disabled = false; }
    }
  }, 'Create schedule');

  mount(fields.project,
    h('option', { value: '' }, 'No project'),
    (store.state.projects || []).map(project => h('option', { value: project.id }, project.name)));

  mount(container,
    listCard,
    h('div.card',
      h('h2.card__title', 'New automation'),
      h('div.stack',
        row('Name', 'What this automation is', fields.name),
        row('What to do', 'Written for a run that will not have this conversation', fields.objective),
        row('Project', 'Which repository it works in', fields.project),
        row('Schedule', 'Five fields, or @daily', fields.cron),
        row('Timezone', 'Wall-clock times are kept in this zone', fields.timezone),
        row('Mode', 'How it works', fields.mode),
        row('Allowed to', 'Nobody is present to approve anything, so choose once', fields.trust),
        preview,
        h('div.row', { style: { justifyContent: 'flex-end' } }, create))));

  refreshPreview();
  load();
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

  /*
     Scroll the section you are in into view.

     The nav scrolls sideways on a phone, and a tab past the fold is a tab
     that looks like it does not exist — arriving at Settings and seeing the
     current section clipped at the edge reads as a rendering bug.
  */
  requestAnimationFrame(() => {
    nav.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  });

  const panels = {
    account: () => accountPanel(save),
    developer: () => developerPanel(save),
    ai: () => aiPanel(save),
    automation: automationPanel,
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
