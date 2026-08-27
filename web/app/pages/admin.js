/**
 * Admin dashboard.
 *
 * Same design language as the product, but information-dense: tables where
 * tables are right, charts only where a shape carries meaning a number does not.
 */

import { h, icon, mount, debounce } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { renderInShell, setSidebarSection } from '../components/shell.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { formatCost, formatCents, formatTokens, formatNumber, formatDuration, relativeTime, formatDate } from '../lib/format.js';

/** Sections, with the icon each gets in the sidebar. */
const SECTIONS = [
  ['overview', 'Overview', 'chart'],
  ['users', 'Users', 'user'],
  ['models', 'Models', 'sparkle'],
  ['providers', 'Providers', 'layers'],
  ['routing', 'Routing', 'git'],
  ['playground', 'Playground', 'terminal'],
  ['costs', 'Costs', 'credit'],
  ['plans', 'Plans', 'projects'],
  ['flags', 'Feature flags', 'settings'],
  ['logs', 'Audit log', 'tasks'],
  ['system', 'System', 'shield']
];

/** One line under each section title, saying what the section is for. */
const SECTION_BLURBS = {
  overview: 'Signups, activity, spend and health, at a glance.',
  users: 'Who is on the platform, what they can do, and what they have used.',
  models: 'Which models exist, what they cost, and which of them users may choose.',
  providers: 'Upstream APIs and their credentials. Keys are written but never read back.',
  routing: 'Which model answers which kind of request, by category and complexity.',
  playground: 'Send a prompt to any model and see the real cost before you route to it.',
  costs: 'Where the money went, by organization, model and day.',
  plans: 'Limits and prices for each plan.',
  flags: 'Features that can be turned on for everyone, or for one organization.',
  logs: 'Every privileged action, who took it, and when.',
  system: 'Version, queue depth, cache state and background jobs.'
};

/** A switch, for a setting that is on or off and saves as soon as it moves. */
function toggle(checked, onChange) {
  const element = h('button.switch', {
    role: 'switch',
    'aria-checked': String(Boolean(checked)),
    onClick: async () => {
      const next = element.getAttribute('aria-checked') !== 'true';
      element.setAttribute('aria-checked', String(next));
      try {
        await onChange(next);
      } catch (error) {
        // Put it back: the control must never claim a state the server refused.
        element.setAttribute('aria-checked', String(!next));
        toastError(error);
      }
    }
  });
  return element;
}

const money = micros => formatCost(micros, { precise: true });

/** A titled table. Keeps the deeply-nested call sites out of the sections. */
function tableCard(title, headers, rows) {
  return h('div.card.card--flush',
    h('div.panel__head', h('span.panel__title', title)),
    h('div.table-wrap',
      h('table.table',
        h('thead', h('tr', headers.map(([label, numeric]) => h(numeric ? 'th.num' : 'th', label)))),
        h('tbody', rows)
      )
    )
  );
}

// ─── overview ───────────────────────────────────────────────────────────────

async function overviewSection() {
  const data = await api.get('/admin/overview');

  const tile = (label, value, delta) => h('div.stat',
    h('div.stat__label', label),
    h('div.stat__value', value),
    delta ? h('div.stat__delta', { class: delta.startsWith('+') ? 'stat__delta--up' : delta.startsWith('-') ? 'stat__delta--down' : '' }, delta) : null
  );

  const series = data.ai.series.slice(-30);
  const peak = Math.max(1, ...series.map(day => day.costMicros));

  return h('div',
    h('div.grid.grid--4', { style: { marginBottom: 'var(--s-4)' } },
      tile('Users', formatNumber(data.users.total), `+${data.users.newLast7Days} this week`),
      tile('Active (7d)', formatNumber(data.users.activeLast7Days)),
      tile('Organizations', formatNumber(data.organizations)),
      tile('Projects', formatNumber(data.projects))
    ),

    h('div.grid.grid--4', { style: { marginBottom: 'var(--s-6)' } },
      tile('MRR', formatCents(data.revenue.mrrCents)),
      tile('AI cost (30d)', formatCents(data.revenue.aiCostCents)),
      tile('Gross margin', data.revenue.grossMarginRatio === null ? '—' : `${Math.round(data.revenue.grossMarginRatio * 100)}%`,
        data.revenue.targetMargin ? `target ${Math.round(data.revenue.targetMargin * 100)}%` : null),
      tile('Tasks (24h)', formatNumber(data.tasks.last24h),
        data.tasks.failedLast24h ? `${data.tasks.failedLast24h} failed` : 'all succeeded')
    ),

    series.length ? h('div.card', { style: { marginBottom: 'var(--s-4)' } },
      h('div.row.row--between', { style: { marginBottom: 'var(--s-4)' } },
        h('div.eyebrow', 'Daily AI cost'),
        data.ai.costChange7dPercent !== null
          ? h('span.badge', { class: data.ai.costChange7dPercent > 30 ? 'badge--warning' : '' },
              `${data.ai.costChange7dPercent > 0 ? '+' : ''}${data.ai.costChange7dPercent}% vs previous 7 days`)
          : null),
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '110px' } },
        series.map(day => h('div', {
          title: `${day.day}: ${money(day.costMicros)} · ${formatNumber(day.requests)} requests`,
          style: {
            flex: '1',
            height: `${Math.max(2, (day.costMicros / peak) * 100)}%`,
            background: day.errors ? 'var(--warning)' : 'var(--accent)',
            opacity: '0.8',
            borderRadius: '2px 2px 0 0'
          }
        }))),
      h('div.row.row--between', { style: { marginTop: 'var(--s-2)', fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)' } },
        h('span', series[0]?.day || ''),
        h('span', `${formatNumber(data.ai.requests30d)} requests · avg ${money(data.ai.avgCostPerRequestMicros)}`),
        h('span', series[series.length - 1]?.day || ''))
    ) : null,

    h('div.grid.grid--2',
      h('div.card',
        h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'Subscriptions'),
        h('dl.meta-list', Object.entries(data.subscriptions.byPlan).map(([code, count]) =>
          h('div.meta-row', h('dt.meta-row__label', code), h('dd.meta-row__value', formatNumber(count)))))),

      h('div.card',
        h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'System'),
        h('dl.meta-list',
          h('div.meta-row', h('dt.meta-row__label', 'Uptime'), h('dd.meta-row__value', formatDuration(data.system.uptimeSeconds * 1000))),
          h('div.meta-row', h('dt.meta-row__label', 'Requests'), h('dd.meta-row__value', formatNumber(data.system.requests))),
          h('div.meta-row', h('dt.meta-row__label', 'Error rate'), h('dd.meta-row__value', `${(data.system.errorRate * 100).toFixed(2)}%`)),
          h('div.meta-row', h('dt.meta-row__label', 'p95 latency'), h('dd.meta-row__value', `${Math.round(data.system.latency.p95)}ms`)),
          h('div.meta-row', h('dt.meta-row__label', 'Memory'), h('dd.meta-row__value', `${data.system.memoryMb}MB`))))
    )
  );
}

// ─── users ──────────────────────────────────────────────────────────────────

async function usersSection() {
  const container = h('div');
  const tableSlot = h('div');
  const search = h('input.input', {
    type: 'search', placeholder: 'Search by email…', 'aria-label': 'Search users',
    style: { maxWidth: '280px' }
  });

  async function load(query = '') {
    mount(tableSlot, h('div.skeleton', { style: { height: '200px' } }));
    try {
      const { users, total } = await api.get(
        `/admin/users?limit=50${query ? `&q=${encodeURIComponent(query)}` : ''}`);

      const rows = users.map(user => h('tr',
        h('td',
          h('div', { style: { color: 'var(--text-strong)' } }, user.fullName || '—'),
          h('div.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, user.email)),
        h('td', relativeTime(user.createdAt)),
        h('td', user.lastSeenAt ? relativeTime(user.lastSeenAt) : 'never'),
        h('td', user.suspended
          ? h('span.badge.badge--danger', 'suspended')
          : h('span.badge.badge--success', 'active')),
        h('td', h('button.btn.btn--ghost.btn--sm', {
          onClick: () => openUser(user.id, () => load(search.value))
        }, 'Inspect'))
      ));

      mount(tableSlot, tableCard(`${formatNumber(total)} users`,
        [['User'], ['Joined'], ['Last seen'], ['Status'], ['']], rows));
    } catch (error) {
      mount(tableSlot, h('div.empty', h('p.empty__body', error.message)));
    }
  }

  search.addEventListener('input', debounce(() => load(search.value.trim()), 260));
  mount(container, h('div.row', { style: { marginBottom: 'var(--s-4)' } }, search), tableSlot);
  await load();
  return container;
}

async function openUser(userId, onChange) {
  const body = h('div', h('div.skeleton', { style: { height: '200px' } }));
  const modal = openModal({ title: 'User', body, wide: true });

  try {
    const data = await api.get(`/admin/users/${userId}`);
    const { user, organizations, usage30d, recentTasks, securityEvents } = data;

    mount(body,
      h('div.row', { style: { gap: 'var(--s-4)', marginBottom: 'var(--s-5)' } },
        h('div', { style: { flex: '1' } },
          h('div', { style: { fontSize: 'var(--fs-lg)', color: 'var(--text-strong)' } }, user.fullName || user.email),
          h('div.subtle', { style: { fontSize: 'var(--fs-sm)' } }, user.email),
          h('div.subtle', { style: { fontSize: 'var(--fs-2xs)', marginTop: 'var(--s-2)' } },
            `Joined ${formatDate(user.createdAt)}${user.lastSeenAt ? ` · last seen ${relativeTime(user.lastSeenAt)}` : ''}`)),
        h('button.btn', { class: user.suspended ? '' : 'btn--danger' , onClick: async () => {
          try {
            await api.post(`/admin/users/${userId}/suspend`, { suspended: !user.suspended, reason: user.suspended ? '' : 'Suspended by administrator' });
            toast.success(user.suspended ? 'Account reactivated.' : 'Account suspended.');
            modal.close();
            onChange?.();
          } catch (error) { toastError(error); }
        } }, user.suspended ? 'Reactivate' : 'Suspend')
      ),

      h('div.grid.grid--4', { style: { marginBottom: 'var(--s-5)' } },
        [['AI cost', money(usage30d.costMicros)], ['Tokens', formatTokens(usage30d.inputTokens + usage30d.outputTokens)],
         ['Requests', formatNumber(usage30d.requests)], ['Errors', formatNumber(usage30d.errors)]].map(([label, value]) =>
          h('div.stat', h('div.stat__label', label), h('div.stat__value', { style: { fontSize: 'var(--fs-lg)' } }, value)))),

      organizations.length ? h('div', { style: { marginBottom: 'var(--s-5)' } },
        h('div.eyebrow', { style: { marginBottom: 'var(--s-2)' } }, 'Organizations'),
        h('div.row.row--wrap', organizations.map(org => h('span.badge', `${org.name} · ${org.role}`)))) : null,

      recentTasks.length ? h('div', { style: { marginBottom: 'var(--s-5)' } },
        h('div.eyebrow', { style: { marginBottom: 'var(--s-2)' } }, 'Recent tasks'),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Task'), h('th', 'Status'), h('th.num', 'Cost'), h('th', 'When'))),
          h('tbody', recentTasks.slice(0, 10).map(task => h('tr',
            h('td.truncate', { style: { maxWidth: '260px' } }, task.title),
            h('td', h('span.badge', task.status)),
            h('td.num', money(task.costMicros)),
            h('td', relativeTime(task.createdAt)))))))) : null,

      securityEvents.length ? h('div',
        h('div.eyebrow', { style: { marginBottom: 'var(--s-2)' } }, 'Security events'),
        h('div.table-wrap', h('table.table',
          h('tbody', securityEvents.slice(0, 10).map(event => h('tr',
            h('td', event.action),
            h('td.mono', event.ip || '—'),
            h('td', relativeTime(event.created_at)))))))) : null
    );
  } catch (error) {
    mount(body, h('div.empty', h('p.empty__body', error.message)));
  }
}

// ─── models & providers ─────────────────────────────────────────────────────

async function modelsSection() {
  const container = h('div', h('div.skeleton', { style: { height: '260px' } }));

  // Filtered here rather than at the API: the catalogue is a few dozen rows,
  // it is already loaded, and a round trip per keystroke would be slower than
  // not searching at all.
  const search = h('input.input', {
    type: 'search',
    placeholder: 'Search by name, id, provider or tier…',
    'aria-label': 'Search models'
  });

  let catalogue = [];

  function matches(model, query) {
    if (!query) return true;
    const haystack = [model.name, model.code, model.providerCode, model.description, ...(model.tiers || [])]
      .filter(Boolean).join(' ').toLowerCase();
    // Every word must appear, so "anthropic haiku" narrows rather than widens.
    return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
  }

  async function load(refresh = true) {
    if (refresh) ({ models: catalogue } = await api.get('/admin/ai/models'));

    const query = search.value.trim();
    const models = catalogue.filter(model => matches(model, query));

    const rows = models.map(model => h('tr',
      h('td',
        h('div', { style: { color: 'var(--text-strong)' } }, model.name),
        h('div.subtle.mono', { style: { fontSize: 'var(--fs-2xs)' } }, model.code)),
      h('td', model.providerCode || '—'),
      h('td.num', money(model.inputPriceMicros)),
      h('td.num', money(model.outputPriceMicros)),
      h('td.num', formatTokens(model.contextWindow)),
      h('td', h('div.row.row--wrap', { style: { gap: '3px' } },
        model.tiers.map(tier => h('span.badge', tier.replace('level', 'L'))))),
      h('td', model.enabled
        ? h('span.badge.badge--success', 'routing')
        : h('span.badge', 'off')),
      // Two different questions: may the router use it, and may a person pick
      // it. The second is what the chat panel's model list is built from.
      h('td', toggle(model.userSelectable, async next => {
        await api.patch(`/admin/ai/models/${model.id}`, { userSelectable: next });
        model.userSelectable = next;
        toast.success(next ? `${model.name} is open to users.` : `${model.name} is no longer offered to users.`);
      })),
      h('td', h('div.row', { style: { gap: '2px' } },
        h('button.btn.btn--ghost.btn--sm', { onClick: () => editModel(model, load) }, 'Edit'),
        h('button.btn.btn--ghost.btn--sm', {
          onClick: async () => {
            try {
              await api.patch(`/admin/ai/models/${model.id}`, { enabled: !model.enabled });
              toast.success(model.enabled ? 'Model disabled.' : 'Model enabled.');
              load();
            } catch (error) { toastError(error); }
          }
        }, model.enabled ? 'Disable' : 'Enable')))
    ));

    const open = catalogue.filter(model => model.userSelectable).length;

    /*
       The search comes first.

       It used to sit 436 pixels down the page, under two paragraphs of
       reference prose and the Add button — on a phone that is a full screen of
       scrolling before the one control anybody came here to use, which is why
       people reported there was no search at all. The prose is reference; the
       search is the tool.
    */
    mount(container,
      h('div.toolbar',
        search,
        h('button.btn.btn--primary.btn--sm.toolbar__action', { onClick: () => editModel(null, load) },
          icon('plus', { size: 13 }), 'Add model')),

      h('div', { style: { margin: '0 0 var(--s-4)' } },
        h('p.subtle', { style: { fontSize: 'var(--fs-xs)', margin: '0' } },
          'Prices are per million tokens; verify against the provider price list before enabling a model. '
          + `Routing decides which model answers by default. Open to users decides what appears in the chat model picker — ${open} of ${catalogue.length} ${open === 1 ? 'is' : 'are'} open.`)),

      rows.length
        ? tableCard(
            query ? `${models.length} of ${catalogue.length} models` : 'Models',
            [['Model'], ['Provider'], ['In / 1M', true], ['Out / 1M', true],
             ['Context', true], ['Tiers'], ['Routing'], ['Open to users'], ['']],
            rows)
        : h('div.card.empty',
            h('div.empty__title', `Nothing matches "${query}"`),
            h('p.empty__body',
              `${catalogue.length} models are configured. Try a provider name, part of a model id, or a tier such as "level2".`))
    );

    // Rebuilding the panel moves the input; focus and cursor go back where the
    // person left them.
    if (query && document.activeElement !== search) {
      requestAnimationFrame(() => {
        search.focus();
        search.setSelectionRange(query.length, query.length);
      });
    }
  }

  search.addEventListener('input', debounce(() => load(false), 160));

  await load();
  return container;
}

async function editModel(model, onSaved) {
  const { providers } = await api.get('/admin/ai/providers');
  const fields = {};

  const field = (key, label, input, hint) => {
    fields[key] = input;
    return h('div.field', h('label.label', label), input, hint ? h('p.field__hint', hint) : null);
  };

  const body = h('div.stack',
    field('providerId', 'Provider',
      h('select.select', providers.map(provider =>
        h('option', { value: provider.id, selected: model?.providerId === provider.id }, `${provider.name} (${provider.adapter})`)))),
    field('code', 'Model id at the provider', h('input.input', { value: model?.code || '', placeholder: 'anthropic/claude-sonnet-4' })),
    field('name', 'Display name', h('input.input', { value: model?.name || '', placeholder: 'Dirox Reason' }),
      'What users see. It does not have to be the provider\'s name.'),
    field('description', 'Description', h('input.input', { value: model?.description || '', maxlength: '400' })),
    h('div.grid.grid--2',
      field('inputPriceMicros', 'Input price (micro-USD / 1M)', h('input.input', { type: 'number', value: String(model?.inputPriceMicros ?? 0) })),
      field('outputPriceMicros', 'Output price (micro-USD / 1M)', h('input.input', { type: 'number', value: String(model?.outputPriceMicros ?? 0) }))),
    field('cachedInputPriceMicros', 'Cached input price (micro-USD / 1M)',
      h('input.input', { type: 'number', value: String(model?.cachedInputPriceMicros ?? '') }), 'Leave empty if the provider does not discount cached input.'),
    h('div.grid.grid--2',
      field('contextWindow', 'Context window', h('input.input', { type: 'number', value: String(model?.contextWindow ?? 128000) })),
      field('maxOutput', 'Max output', h('input.input', { type: 'number', value: String(model?.maxOutput ?? 8192) }))),
    field('tiers', 'Routing tiers',
      h('div.row.row--wrap', ['level0', 'level1', 'level2', 'level3', 'level4'].map(tier => {
        const checked = model?.tiers?.includes(tier) ?? ['level1', 'level2'].includes(tier);
        const chip = h('button.badge', {
          'aria-pressed': String(checked),
          style: { cursor: 'pointer', ...(checked ? { borderColor: 'var(--accent-line)', background: 'var(--accent-quiet)', color: 'var(--red-300)' } : {}) },
          onClick: () => {
            const on = chip.getAttribute('aria-pressed') !== 'true';
            chip.setAttribute('aria-pressed', String(on));
            Object.assign(chip.style, on
              ? { borderColor: 'var(--accent-line)', background: 'var(--accent-quiet)', color: 'var(--red-300)' }
              : { borderColor: '', background: '', color: '' });
          }
        }, tier.replace('level', 'L'));
        return chip;
      })), 'Which complexity levels this model may serve.'),
    h('div.grid.grid--2',
      h('div.field', h('label.label', 'Capabilities'),
        h('div.stack--tight', { class: 'stack' },
          ...['supportsTools', 'supportsVision', 'supportsReasoning', 'supportsPromptCache'].map(key => {
            const input = h('input', { type: 'checkbox', checked: model ? model[key] : key === 'supportsTools' });
            fields[key] = input;
            return h('label.row', { style: { gap: 'var(--s-2)', fontSize: 'var(--fs-sm)', cursor: 'pointer' } },
              input, h('span', key.replace('supports', '').replace(/([A-Z])/g, ' $1').trim()));
          }))),
      field('priority', 'Priority', h('input.input', { type: 'number', value: String(model?.priority ?? 100) }), 'Lower is preferred.')),
    h('div.field',
      h('label.label', 'Availability'),
      h('label.row', { style: { gap: 'var(--s-2)', fontSize: 'var(--fs-sm)', cursor: 'pointer' } },
        (fields.userSelectable = h('input', { type: 'checkbox', checked: Boolean(model?.userSelectable) })),
        h('span', 'Users may choose this model in the chat panel')),
      h('p.field__hint', 'Off by default. A model can serve routing without being offered as a choice.'))
  );

  const save = h('button.btn.btn--primary', {
    onClick: async () => {
      save.disabled = true;
      try {
        const tiers = [...body.querySelectorAll('[aria-pressed="true"]')].map(chip => `level${chip.textContent.slice(1)}`);
        const payload = {
          providerId: fields.providerId.value,
          code: fields.code.value.trim(),
          name: fields.name.value.trim(),
          description: fields.description.value.trim(),
          inputPriceMicros: Number(fields.inputPriceMicros.value) || 0,
          outputPriceMicros: Number(fields.outputPriceMicros.value) || 0,
          contextWindow: Number(fields.contextWindow.value) || 128000,
          maxOutput: Number(fields.maxOutput.value) || 8192,
          tiers: tiers.length ? tiers : ['level1'],
          priority: Number(fields.priority.value) || 100,
          supportsTools: fields.supportsTools.checked,
          supportsVision: fields.supportsVision.checked,
          supportsReasoning: fields.supportsReasoning.checked,
          supportsPromptCache: fields.supportsPromptCache.checked,
          userSelectable: fields.userSelectable.checked
        };
        const cached = fields.cachedInputPriceMicros.value.trim();
        if (cached) payload.cachedInputPriceMicros = Number(cached);

        if (model) await api.patch(`/admin/ai/models/${model.id}`, payload);
        else await api.post('/admin/ai/models', payload);

        toast.success(model ? 'Model updated.' : 'Model added.');
        modal.close();
        onSaved?.();
      } catch (error) {
        toastError(error);
        save.disabled = false;
      }
    }
  }, model ? 'Save changes' : 'Add model');

  const modal = openModal({
    title: model ? `Edit ${model.name}` : 'Add a model',
    wide: true,
    body,
    actions: [h('button.btn', { onClick: () => modal.close() }, 'Cancel'), save]
  });
}

async function providersSection() {
  const container = h('div', h('div.skeleton', { style: { height: '200px' } }));

  async function load() {
    const { providers } = await api.get('/admin/ai/providers');

    const testProvider = async (provider, button) => {
      button.disabled = true;
      button.textContent = 'Testing…';
      try {
        const result = await api.post(`/admin/ai/providers/${provider.id}/health`, {});
        const detail = result.detail?.error ? ` — ${result.detail.error}` : ` (${result.latencyMs}ms)`;
        toast[result.status === 'healthy' ? 'success' : 'error'](`${provider.name}: ${result.status}${detail}`);
        load();
      } catch (error) {
        toastError(error);
        button.disabled = false;
        button.textContent = 'Test';
      }
    };

    const rows = providers.map(provider => h('tr',
      h('td',
        h('div', { style: { color: 'var(--text-strong)' } }, provider.name),
        h('div.subtle.mono', { style: { fontSize: 'var(--fs-2xs)' } }, provider.baseUrl)),
      h('td', provider.adapter),
      h('td', provider.keyConfigured
        ? h('div',
            h('span.badge.badge--success', provider.keySource),
            h('div.subtle.mono', { style: { fontSize: 'var(--fs-2xs)', marginTop: '2px' } }, provider.keyPreview))
        : h('span.badge.badge--danger', provider.keyRef ? `${provider.keyRef} not set` : 'no key')),
      h('td', h('span.badge', {
        class: provider.healthStatus === 'healthy' ? 'badge--success'
          : provider.healthStatus === 'down' ? 'badge--danger'
          : provider.healthStatus === 'degraded' ? 'badge--warning' : ''
      }, provider.healthStatus)),
      h('td', provider.enabled
        ? h('span.badge.badge--success', 'enabled')
        : h('span.badge', 'disabled')),
      h('td', h('div.row', { style: { gap: '2px' } },
        h('button.btn.btn--ghost.btn--sm', {
          onClick: event => testProvider(provider, event.currentTarget)
        }, 'Test'),
        h('button.btn.btn--ghost.btn--sm', {
          onClick: async () => {
            try {
              await api.patch(`/admin/ai/providers/${provider.id}`, { enabled: !provider.enabled });
              load();
            } catch (error) { toastError(error); }
          }
        }, provider.enabled ? 'Disable' : 'Enable')))
    ));

    mount(container,
      h('p.muted', { style: { fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-4)' } },
        'Prefer a key reference — an environment variable name — so the secret stays in your deployment configuration rather than the database.'),
      tableCard('Providers',
        [['Provider'], ['Adapter'], ['Key'], ['Health'], ['Status'], ['']], rows)
    );
  }

  await load();
  return container;
}

// ─── routing ────────────────────────────────────────────────────────────────

async function routingSection() {
  const container = h('div', h('div.skeleton', { style: { height: '300px' } }));

  async function load() {
    const { routes, categories, levels, models } = await api.get('/admin/ai/routes');
    const byCategory = new Map();
    for (const route of routes) {
      if (!byCategory.has(route.category)) byCategory.set(route.category, []);
      byCategory.get(route.category).push(route);
    }

    mount(container,
      h('p.muted', { style: { fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-5)' } },
        'A task is classified into a category and a complexity level, then routed here. Changes take effect on the next request — no redeploy.'),

      h('div.stack', categories.map(category => {
        const categoryRoutes = byCategory.get(category) || [];
        return h('div.card',
          h('div.row.row--between', { style: { marginBottom: 'var(--s-3)' } },
            h('div.panel__title', { style: { textTransform: 'capitalize' } }, category),
            h('button.btn.btn--ghost.btn--sm', { onClick: () => editRoute({ category }, models, levels, load) },
              icon('plus', { size: 12 }), 'Add rule')),

          categoryRoutes.length
            ? h('div.stack--tight', { class: 'stack' }, levels.map(level => {
                const rule = categoryRoutes.find(route => route.level === level);
                if (!rule) return null;
                return h('div.row.row--between', {
                  style: { padding: 'var(--s-2) var(--s-3)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--bg-inset)' }
                },
                  h('div.row', { style: { gap: 'var(--s-3)', minWidth: '0' } },
                    h('span.badge', level.replace('level', 'L')),
                    icon('arrowRight', { size: 12 }),
                    h('span.truncate', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text-strong)' } }, rule.modelName || 'unknown model'),
                    rule.fallbackModelName ? h('span.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, `fallback: ${rule.fallbackModelName}`) : null,
                    rule.reasoningEffort && rule.reasoningEffort !== 'none' ? h('span.badge', `reasoning ${rule.reasoningEffort}`) : null),
                  h('div.row', { style: { gap: '2px' } },
                    h('button.btn.btn--ghost.btn--sm', { onClick: () => editRoute(rule, models, levels, load) }, 'Edit'),
                    h('button.btn.btn--ghost.btn--sm', {
                      onClick: () => confirmModal({
                        title: 'Remove this routing rule?',
                        message: `${category} at ${level} will fall back to the next lower level.`,
                        confirmLabel: 'Remove',
                        onConfirm: async () => { await api.delete(`/admin/ai/routes/${rule.id}`); toast.success('Rule removed.'); load(); }
                      })
                    }, 'Remove')));
              }).filter(Boolean))
            : h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'No rule configured — requests fall back to the cheapest capable model.')
        );
      }))
    );
  }

  await load();
  return container;
}

function editRoute(rule, models, levels, onSaved) {
  const level = h('select.select', levels.map(value =>
    h('option', { value, selected: rule.level === value }, value.replace('level', 'Level '))));
  const model = h('select.select', models.map(item =>
    h('option', { value: item.id, selected: rule.modelId === item.id }, item.name)));
  const fallback = h('select.select',
    h('option', { value: '' }, 'None'),
    models.map(item => h('option', { value: item.id, selected: rule.fallbackModelId === item.id }, item.name)));
  const maxOutput = h('input.input', { type: 'number', value: String(rule.maxOutputTokens ?? 4096) });
  const temperature = h('input.input', { type: 'number', step: '0.1', min: '0', max: '2', value: String(rule.temperature ?? 0.2) });
  const effort = h('select.select', ['none', 'low', 'medium', 'high'].map(value =>
    h('option', { value, selected: (rule.reasoningEffort || 'none') === value }, value)));
  const notes = h('input.input', { value: rule.notes || '', maxlength: '300' });

  const save = h('button.btn.btn--primary', {
    onClick: async () => {
      save.disabled = true;
      try {
        await api.put('/admin/ai/routes', {
          category: rule.category,
          level: level.value,
          modelId: model.value,
          fallbackModelId: fallback.value || undefined,
          maxOutputTokens: Number(maxOutput.value) || undefined,
          temperature: Number(temperature.value),
          reasoningEffort: effort.value,
          notes: notes.value
        });
        toast.success('Routing updated.');
        modal.close();
        onSaved?.();
      } catch (error) { toastError(error); save.disabled = false; }
    }
  }, 'Save rule');

  const modal = openModal({
    title: `Routing: ${rule.category}`,
    body: h('div.stack',
      h('div.field', h('label.label', 'Complexity level'), level),
      h('div.field', h('label.label', 'Model'), model),
      h('div.field', h('label.label', 'Fallback model'), fallback, h('p.field__hint', 'Used once if the primary model fails. Never a cascade.')),
      h('div.grid.grid--2',
        h('div.field', h('label.label', 'Max output tokens'), maxOutput),
        h('div.field', h('label.label', 'Temperature'), temperature)),
      h('div.field', h('label.label', 'Reasoning effort'), effort, h('p.field__hint', 'Only applies to models that support it.')),
      h('div.field', h('label.label', 'Notes'), notes)),
    actions: [h('button.btn', { onClick: () => modal.close() }, 'Cancel'), save]
  });
}

// ─── playground ─────────────────────────────────────────────────────────────

async function playgroundSection() {
  const { models } = await api.get('/admin/ai/models');
  const enabled = models.filter(model => model.enabled);

  const modelSelect = h('select.select', enabled.map(model =>
    h('option', { value: model.id }, `${model.name} — ${model.providerCode}`)));
  const system = h('textarea.textarea', { rows: '3', placeholder: 'Optional system prompt', maxlength: '8000' });
  const prompt = h('textarea.textarea', { rows: '6', placeholder: 'Write a prompt to test this model with…', maxlength: '20000' });
  const temperature = h('input.input', { type: 'number', step: '0.1', min: '0', max: '2', value: '0.2' });
  const maxTokens = h('input.input', { type: 'number', value: '1024', min: '32', max: '32000' });
  const output = h('div');

  const run = h('button.btn.btn--primary', {
    onClick: async () => {
      if (!prompt.value.trim()) return;
      run.disabled = true;
      mount(run, h('span.btn__spinner'), 'Running…');
      mount(output, h('div.skeleton', { style: { height: '120px' } }));

      try {
        const result = await api.post('/admin/ai/playground', {
          modelId: modelSelect.value,
          system: system.value,
          prompt: prompt.value,
          temperature: Number(temperature.value),
          maxTokens: Number(maxTokens.value)
        });

        mount(output,
          h('div.card',
            h('div.row.row--between', { style: { marginBottom: 'var(--s-3)' } },
              h('div.eyebrow', result.ok ? 'Response' : 'Failed'),
              h('div.row', { style: { gap: 'var(--s-3)', fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)' } },
                h('span', `${result.latencyMs}ms`),
                result.usage ? h('span', `${formatTokens(result.usage.inputTokens)} in / ${formatTokens(result.usage.outputTokens)} out`) : null,
                result.costMicros !== undefined ? h('span', money(result.costMicros)) : null)),
            result.ok
              ? h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)', margin: '0', fontFamily: 'var(--font-sans)' } }, result.text)
              : h('p.field__error', result.error.message))
        );
      } catch (error) {
        mount(output, h('div.card', h('p.field__error', error.message)));
      } finally {
        run.disabled = false;
        mount(run, 'Run');
      }
    }
  }, 'Run');

  return h('div',
    h('p.muted', { style: { fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-4)' } },
      'Compare models on a real prompt before enabling them for routing. These are real calls and they cost real money.'),
    h('div.card.stack',
      h('div.grid.grid--2',
        h('div.field', h('label.label', 'Model'), modelSelect),
        h('div.grid.grid--2',
          h('div.field', h('label.label', 'Temperature'), temperature),
          h('div.field', h('label.label', 'Max output'), maxTokens))),
      h('div.field', h('label.label', 'System prompt'), system),
      h('div.field', h('label.label', 'Prompt'), prompt),
      h('div.row', { style: { justifyContent: 'flex-end' } }, run)),
    h('div', { style: { marginTop: 'var(--s-4)' } }, output)
  );
}

// ─── costs ──────────────────────────────────────────────────────────────────

async function costsSection() {
  const data = await api.get('/admin/costs?days=30');

  const alerts = data.alerts.length
    ? h('div.stack--tight', { class: 'stack', style: { marginBottom: 'var(--s-5)' } },
        data.alerts.map(alert => h('div.task-strip', {
          style: { borderColor: alert.severity === 'critical' ? 'var(--accent-line)' : 'var(--border-strong)' }
        },
          h('span.dot', { class: alert.severity === 'critical' ? 'dot--danger' : 'dot--warning' }),
          h('span.task-strip__label', alert.message)
        )))
    : null;

  const totals = h('div.grid.grid--3', { style: { marginBottom: 'var(--s-5)' } },
    h('div.stat', h('div.stat__label', 'AI cost (30d)'), h('div.stat__value', money(data.totals.costMicros))),
    h('div.stat', h('div.stat__label', 'Requests'), h('div.stat__value', formatNumber(data.totals.requests))),
    h('div.stat', h('div.stat__label', 'Avg per request'), h('div.stat__value', money(data.totals.avgCostPerRequestMicros)))
  );

  const modelRows = data.byModel.map(model => h('tr',
    h('td.mono', model.modelName || model.modelCode),
    h('td.num', formatNumber(model.requests)),
    h('td.num', formatTokens(model.inputTokens)),
    h('td.num', formatTokens(model.outputTokens)),
    h('td.num', formatTokens(model.cachedTokens)),
    h('td.num', `${model.avgLatencyMs}ms`),
    h('td.num', { style: model.errors ? { color: 'var(--danger)' } : {} }, formatNumber(model.errors)),
    h('td.num', money(model.costMicros))
  ));

  const orgRows = data.byOrganization.slice(0, 15).map(org => h('tr',
    h('td.truncate', org.name),
    h('td.num', formatNumber(org.requests)),
    h('td.num', money(org.costMicros))
  ));

  const categoryRows = data.byCategory.map(category => h('tr',
    h('td', category.category),
    h('td.num', formatNumber(category.requests)),
    h('td.num', money(category.costMicros))
  ));

  return h('div',
    alerts,
    totals,
    h('div', { style: { marginBottom: 'var(--s-4)' } },
      tableCard('By model', [
        ['Model'], ['Requests', true], ['Input', true], ['Output', true],
        ['Cached', true], ['Avg latency', true], ['Errors', true], ['Cost', true]
      ], modelRows)),
    h('div.grid.grid--2',
      tableCard('By organization', [['Organization'], ['Requests', true], ['Cost', true]], orgRows),
      tableCard('By category', [['Category'], ['Requests', true], ['Cost', true]], categoryRows)
    )
  );
}

// ─── plans, flags, logs, system ─────────────────────────────────────────────

async function plansSection() {
  const container = h('div', h('div.skeleton', { style: { height: '200px' } }));

  async function load() {
    const { plans } = await api.get('/admin/plans');
    mount(container,
      h('p.muted', { style: { fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-4)' } },
        'Pricing and limits are data. Changing a plan here affects every organization on it immediately.'),
      h('div.grid.grid--2', plans.map(plan => h('div.card',
        h('div.row.row--between', { style: { marginBottom: 'var(--s-3)' } },
          h('div',
            h('div', { style: { fontSize: 'var(--fs-md)', fontWeight: '600', color: 'var(--text-strong)' } }, plan.name),
            h('div.subtle.mono', { style: { fontSize: 'var(--fs-2xs)' } }, plan.code)),
          h('div', { style: { textAlign: 'right' } },
            h('div', { style: { fontSize: 'var(--fs-lg)', fontWeight: '600' } }, formatCents(plan.price_monthly_cents)),
            h('div.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, 'per month'))),
        h('dl.meta-list',
          [['Projects', plan.max_projects ?? '∞'], ['Tasks/day', plan.max_tasks_per_day ?? '∞'],
           ['Tokens/month', plan.max_tokens_per_month ? formatTokens(plan.max_tokens_per_month) : '∞'],
           ['Concurrent agents', plan.max_concurrent_agents],
           ['Tiers', plan.allowed_model_tiers.map(t => t.replace('level', 'L')).join(' ')]].map(([label, value]) =>
            h('div.meta-row', h('dt.meta-row__label', label), h('dd.meta-row__value', String(value))))),
        h('div.row', { style: { marginTop: 'var(--s-4)', justifyContent: 'flex-end' } },
          h('button.btn.btn--sm', { onClick: () => editPlan(plan, load) }, 'Edit'))
      ))));
  }

  await load();
  return container;
}

function editPlan(plan, onSaved) {
  const fields = {};
  const numberField = (key, label, value, hint) => {
    fields[key] = h('input.input', { type: 'number', value: value === null || value === undefined ? '' : String(value) });
    return h('div.field', h('label.label', label), fields[key], hint ? h('p.field__hint', hint) : null);
  };

  const save = h('button.btn.btn--primary', {
    onClick: async () => {
      save.disabled = true;
      try {
        const payload = {};
        for (const [key, input] of Object.entries(fields)) {
          const raw = input.value.trim();
          if (raw !== '') payload[key] = Number(raw);
        }
        await api.patch(`/admin/plans/${plan.id}`, payload);
        toast.success('Plan updated.');
        modal.close();
        onSaved?.();
      } catch (error) { toastError(error); save.disabled = false; }
    }
  }, 'Save plan');

  const modal = openModal({
    title: `Edit ${plan.name}`,
    wide: true,
    body: h('div.stack',
      h('div.grid.grid--2',
        numberField('priceMonthlyCents', 'Monthly price (cents)', plan.price_monthly_cents),
        numberField('priceYearlyCents', 'Yearly price (cents)', plan.price_yearly_cents)),
      h('div.grid.grid--2',
        numberField('maxProjects', 'Max projects', plan.max_projects, 'Empty means unlimited.'),
        numberField('maxTasksPerDay', 'Max tasks per day', plan.max_tasks_per_day, 'Empty means unlimited.')),
      h('div.grid.grid--2',
        numberField('maxTokensPerMonth', 'Max tokens per month', plan.max_tokens_per_month),
        numberField('maxCostPerMonthCents', 'Max AI spend per month (cents)', plan.max_cost_per_month_cents)),
      h('div.grid.grid--2',
        numberField('maxConcurrentAgents', 'Concurrent agents', plan.max_concurrent_agents),
        numberField('requestsPerMinute', 'Requests per minute', plan.requests_per_minute)),
      numberField('includedCreditsCents', 'Included AI credit (cents)', plan.included_credits_cents)),
    actions: [h('button.btn', { onClick: () => modal.close() }, 'Cancel'), save]
  });
}

async function flagsSection() {
  const container = h('div', h('div.skeleton', { style: { height: '200px' } }));

  async function load() {
    const { flags } = await api.get('/admin/feature-flags');
    mount(container, h('div.card', flags.map(flag => h('div.setting-row',
      h('div',
        h('div.setting-row__label', flag.name),
        h('p.setting-row__hint', flag.description),
        h('div.subtle.mono', { style: { fontSize: 'var(--fs-2xs)', marginTop: '3px' } }, flag.key)),
      h('div.row', { style: { gap: 'var(--s-3)' } },
        h('input.input', {
          type: 'number', min: '0', max: '100', value: String(flag.rollout_percentage),
          style: { width: '78px' },
          title: 'Rollout percentage',
          onChange: async event => {
            await api.patch(`/admin/feature-flags/${flag.key}`, { rolloutPercentage: Number(event.target.value) });
            toast.success('Rollout updated.');
          }
        }),
        (() => {
          const toggle = h('button.switch', {
            role: 'switch', 'aria-checked': String(flag.enabled),
            onClick: async () => {
              const next = toggle.getAttribute('aria-checked') !== 'true';
              toggle.setAttribute('aria-checked', String(next));
              try { await api.patch(`/admin/feature-flags/${flag.key}`, { enabled: next }); }
              catch (error) { toastError(error); toggle.setAttribute('aria-checked', String(!next)); }
            }
          });
          return toggle;
        })())
    ))));
  }

  await load();
  return container;
}

async function logsSection() {
  const container = h('div');
  const slot = h('div');
  const filter = h('select.select', { style: { maxWidth: '200px' } },
    [['', 'All severities'], ['info', 'Info'], ['warning', 'Warning'], ['critical', 'Critical']]
      .map(([value, label]) => h('option', { value }, label)));

  async function load() {
    mount(slot, h('div.skeleton', { style: { height: '200px' } }));
    try {
      const { logs, total } = await api.get(
        `/admin/audit-logs?limit=100${filter.value ? `&severity=${filter.value}` : ''}`);

      const rows = logs.map(log => h('tr',
        h('td', h('span.badge', {
          class: log.severity === 'critical' ? 'badge--danger' : log.severity === 'warning' ? 'badge--warning' : ''
        }, log.action)),
        h('td.mono', { style: { fontSize: 'var(--fs-2xs)' } }, log.actor_type),
        h('td.truncate', { style: { maxWidth: '200px' } },
          log.resource ? `${log.resource}${log.resource_id ? `:${String(log.resource_id).slice(0, 8)}` : ''}` : '—'),
        h('td.mono', { style: { fontSize: 'var(--fs-2xs)' } }, log.ip || '—'),
        h('td', relativeTime(log.created_at))
      ));

      mount(slot, tableCard(`${formatNumber(total)} entries`,
        [['Action'], ['Actor'], ['Resource'], ['IP'], ['When']], rows));
    } catch (error) {
      mount(slot, h('div.empty', h('p.empty__body', error.message)));
    }
  }

  filter.addEventListener('change', load);
  mount(container, h('div.row', { style: { marginBottom: 'var(--s-4)' } }, filter), slot);
  await load();
  return container;
}

async function systemSection() {
  const data = await api.get('/admin/system');

  const tiles = h('div.grid.grid--4', { style: { marginBottom: 'var(--s-5)' } },
    [['Uptime', formatDuration(data.runtime.uptimeSeconds * 1000)],
     ['Requests', formatNumber(data.runtime.requests)],
     ['Error rate', `${(data.runtime.errorRate * 100).toFixed(2)}%`],
     ['Memory', `${data.runtime.memoryMb}MB`]].map(([label, value]) =>
      h('div.stat', h('div.stat__label', label), h('div.stat__value', { style: { fontSize: 'var(--fs-xl)' } }, value))));

  const metaRow = (label, value) => h('div.meta-row',
    h('dt.meta-row__label', label), h('dd.meta-row__value', String(value)));

  const queueCard = h('div.card',
    h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'Queue'),
    h('dl.meta-list',
      metaRow('Pending', formatNumber(data.queue.pending)),
      metaRow('Running', formatNumber(data.queue.running)),
      metaRow('Failed (24h)', formatNumber(data.queue.failed24h)),
      metaRow('Worker', data.worker.running ? 'running' : 'stopped')));

  const latencyCard = h('div.card',
    h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'Latency'),
    h('dl.meta-list',
      metaRow('p50', `${Math.round(data.runtime.latency.p50)}ms`),
      metaRow('p95', `${Math.round(data.runtime.latency.p95)}ms`),
      metaRow('p99', `${Math.round(data.runtime.latency.p99)}ms`),
      metaRow('Model calls', `${formatNumber(data.runtime.model.calls)} (${data.runtime.model.errors} failed)`),
      metaRow('Tool calls', `${formatNumber(data.runtime.tools.calls)} (${data.runtime.tools.errors} failed)`)));

  const capabilities = h('div.card', { style: { marginBottom: 'var(--s-4)' } },
    h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'Capabilities'),
    h('div.row.row--wrap', Object.entries(data.capabilities).map(([key, value]) =>
      h('span.badge', { class: value ? 'badge--success' : 'badge--danger' }, key))));

  const cacheRows = Object.entries(data.caches).map(([name, stats]) => h('tr',
    h('td', name),
    h('td.num', `${stats.size} / ${stats.max}`),
    h('td.num', `${(stats.hitRate * 100).toFixed(0)}%`)));

  const failureRows = data.recentFailures.map(event => h('tr',
    h('td', event.kind),
    h('td.truncate', { style: { maxWidth: '280px' } }, event.name),
    h('td', h('span.badge.badge--danger', event.status)),
    h('td.num', `${event.duration_ms}ms`),
    h('td', relativeTime(event.created_at))));

  return h('div',
    tiles,
    h('div.grid.grid--2', { style: { marginBottom: 'var(--s-4)' } }, queueCard, latencyCard),
    capabilities,
    h('div', { style: { marginBottom: 'var(--s-4)' } },
      tableCard('Caches', [['Cache'], ['Entries', true], ['Hit rate', true]], cacheRows)),
    failureRows.length
      ? tableCard('Recent failures',
          [['Kind'], ['Name'], ['Status'], ['Duration', true], ['When']], failureRows)
      : null
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

const SECTION_RENDERERS = {
  overview: overviewSection, users: usersSection, models: modelsSection,
  providers: providersSection, routing: routingSection, playground: playgroundSection,
  costs: costsSection, plans: plansSection, flags: flagsSection,
  logs: logsSection, system: systemSection
};

export async function render({ params = {} } = {}) {
  const active = SECTION_RENDERERS[params.section] ? params.section : 'overview';
  const content = h('div.view__inner.view__inner--wide');
  const label = SECTIONS.find(([id]) => id === active)?.[1] || 'Overview';

  renderInShell(content, { title: `Admin · ${label}`, crumbs: [['Admin', '/admin'], [label, null]] });

  // Eleven sections is too many for a tab strip and exactly right for the
  // sidebar, which is where the rest of the product's navigation already is.
  setSidebarSection({
    label: 'Administration',
    items: SECTIONS.map(([id, sectionLabel, iconName]) => ({
      href: id === 'overview' ? '/admin' : `/admin/${id}`,
      label: sectionLabel,
      icon: iconName
    }))
  });

  const panel = h('div', h('div.skeleton', { style: { height: '300px' } }));

  mount(content,
    h('div.page-head',
      h('div.page-head__row',
        h('div',
          h('h1.page-head__title', { style: { fontSize: 'var(--fs-2xl)' } }, label),
          h('p.page-head__sub', SECTION_BLURBS[active] || 'Users, models, routing, cost and system health.')),
        h('a.btn.btn--ghost.btn--sm', { href: '/app' }, icon('arrowRight', { size: 13 }), 'Back to DiroxCode'))),

    panel
  );

  try {
    mount(panel, await SECTION_RENDERERS[active]());
  } catch (error) {
    toastError(error, 'This section could not be loaded');
    mount(panel, h('div.empty',
      h('h2.empty__title', 'Unavailable'),
      h('p.empty__body', error.message)));
  }
}
