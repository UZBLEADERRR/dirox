/** Every modal in the app. Bottom sheets, because thumbs live at the bottom. */

import { state, save, allRoles, uid, storageBytes, deleteApp, publishApp } from '../store.js';
import { t } from '../i18n.js';
import { listModels } from '../llm.js';
import { PALETTE, EMOJIS, iconDataUrl, applyAppIdentity } from '../icons.js';
import { $, el, openSheet, closeSheet, confirmSheet, switchRow, field, toast, fmtBytes, ICON, svg } from './dom.js';

const PROVIDERS = [
  ['OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/keys'],
  ['Groq',       'https://api.groq.com/openai/v1', 'https://console.groq.com/keys'],
  ['OpenAI',     'https://api.openai.com/v1', 'https://platform.openai.com/api-keys'],
  ['Other',      '', ''],
];

const providerOf = url => PROVIDERS.find(p => p[1] && url.startsWith(p[1])) || PROVIDERS[3];

/* ------------------------------------------------------------- settings */

export function openSettings(afterChange) {
  const s = state.settings;
  const rerender = () => { closeSheet(); openSettings(afterChange); };

  openSheet(() => {
    const key = el('input', { type:'password', value:s.apiKey, placeholder:'sk-or-v1-…',
      autocomplete:'off', autocapitalize:'off', spellcheck:'false' });
    key.addEventListener('input', () => { s.apiKey = key.value.trim(); save(); afterChange?.(); });

    const base = el('input', { type:'url', value:s.baseUrl, placeholder:'https://…/v1',
      autocapitalize:'off', spellcheck:'false' });
    base.addEventListener('change', () => { s.baseUrl = base.value.trim(); save(); });

    const provider = providerOf(s.baseUrl);
    const provRow = el('div', { class:'seg' }, ...PROVIDERS.map(p =>
      el('button', { class: p === provider ? 'on' : '', text:p[0], onClick:() => {
        if (p[1]) { s.baseUrl = p[1]; save(); }
        rerender();
      }})));

    return [
      el('h3', { text:t('settings') }),

      el('h4', { text:'API' }),
      provRow,
      el('div', { style:{ height:'12px' } }),
      field(t('apiKey'), key, provider[2]
        ? `Get a key from <a href="${provider[2]}" target="_blank" rel="noopener">${provider[0]}</a>. It stays on this phone only.`
        : 'The key stays on this phone only.'),
      field(t('baseUrl'), base),
      el('button', { class:'list-item', onClick:() => openModels(afterChange) },
        el('span', { class:'em', text:'🧠' }),
        el('span', { class:'txt' },
          el('b', { text:t('model') }),
          el('small', { text:s.modelName || s.model || t('chooseModel') })),
        svg('<path d="M9 6l6 6-6 6"/>', 'class="tick"')),

      el('h4', { text:t('market') }),
      (() => {
        const mk = el('input', { type:'url', value:s.marketUrl || '', placeholder:location.origin,
          autocapitalize:'off', spellcheck:'false' });
        mk.addEventListener('change', () => { s.marketUrl = mk.value.trim(); save(); });
        return field(t('marketUrl'), mk,
          'Leave empty to use this site. Point it elsewhere to read a different market.');
      })(),
      el('h4', { text:t('roles') }),
      ...allRoles().map(r => el('button', { class:'list-item', onClick:() => openRoleEditor(r, rerender) },
        el('span', { class:'em', text:r.emoji }),
        el('span', { class:'txt' },
          el('b', { text: r.name }),
          el('small', { text: r.tools ? t('roleTools') : (r.prompt || '').slice(0, 48) })))),
      el('button', { class:'list-item', onClick:() => openRoleEditor(null, rerender) },
        el('span', { class:'em', text:'＋' }),
        el('span', { class:'txt' }, el('b', { text:t('newRole') }))),

      el('h4', { text:t('theme') }),
      el('div', { class:'seg' }, ...[['system',t('system')],['dark',t('dark')],['light',t('light')]].map(([v,n]) =>
        el('button', { class:s.theme === v ? 'on' : '', text:n, onClick:() => {
          s.theme = v; save(); applyTheme(); rerender();
        }}))),

      el('h4', { text:'Model' }),
      sliderRow('Creativity (temperature)', s.temperature, 0, 1.4, 0.1, v => { s.temperature = v; save(); }),
      sliderRow('Messages remembered', s.historyLimit, 6, 60, 2, v => { s.historyLimit = v; save(); }),
      sliderRow('Agent step limit', s.maxSteps, 4, 60, 1, v => { s.maxSteps = v; save(); }),

      el('h4', { text:t('storage') }),
      el('div', { class:'note', text:`${fmtBytes(storageBytes())} · ${state.chats.length} chats · ${state.apps.length} apps` }),
      el('div', { class:'btn-row' },
        el('button', { class:'btn danger', text:t('clearAll'), onClick:async () => {
          if (await confirmSheet({ title:t('clearAll'), text:'Every chat and app on this device is removed.', ok:t('delete') })) {
            for (const k of Object.keys(localStorage)) if (k.startsWith('mini.')) localStorage.removeItem(k);
            location.reload();
          }
        }})),

      el('div', { class:'note', style:{ marginTop:'18px' },
        html:'<b>Mini</b> is open source. Your chats and apps never leave this device; requests go straight to the API you chose.' }),
    ];
  });
}

function sliderRow(label, value, min, max, step, onChange) {
  const out = el('b', { text:String(value) });
  const input = el('input', { type:'range', min, max, step, value });
  input.addEventListener('input', () => { out.textContent = input.value; onChange(Number(input.value)); });
  return el('div', { class:'field' },
    el('label', { style:{ display:'flex', justifyContent:'space-between' } },
      el('span', { text:label }), out),
    input);
}

/* -------------------------------------------------------------- models */

let modelCache = null;

export function openModels(afterChange) {
  const s = state.settings;
  openSheet(() => {
    const search = el('input', { type:'search', placeholder:t('searchModel') });
    const list = el('div');
    const wrap = el('div', {},
      el('h3', { text:t('chooseModel') }),
      el('div', { class:'model-search' }, search),
      list);

    const manual = () => {
      const inp = el('input', { value:s.model, placeholder:'masalan: openai/gpt-4o-mini' });
      inp.addEventListener('change', () => {
        s.model = inp.value.trim(); s.modelName = s.model; save(); afterChange?.(); toast(t('done'));
      });
      return field('Model ID (qo\'lda)', inp);
    };

    const render = (rows) => {
      const q = search.value.toLowerCase().trim();
      const shown = rows.filter(m => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
                        .slice(0, 120);
      list.innerHTML = '';
      if (!shown.length) list.append(el('div', { class:'note', text:t('noModels') }));
      for (const m of shown) {
        const price = m.free ? 'bepul'
          : m.priceIn ? `$${m.priceIn.toFixed(2)}/$${m.priceOut.toFixed(2)} 1M` : '';
        list.append(el('button', { class:`list-item ${m.id === s.model ? 'sel' : ''}`, onClick:() => {
          s.model = m.id; s.modelName = m.name; save(true); afterChange?.(); closeSheet(); toast(m.name);
        }},
          el('span', { class:'em', text:m.vision ? '👁' : '🧠' }),
          el('span', { class:'txt' },
            el('b', { text:m.name }),
            el('small', { text:[m.id, price, m.ctx ? `${Math.round(m.ctx/1000)}k` : ''].filter(Boolean).join(' · ') })),
          m.id === s.model ? svg(ICON.check, 'class="tick"') : null));
      }
    };

    search.addEventListener('input', () => modelCache && render(modelCache));

    (async () => {
      if (modelCache) return render(modelCache);
      list.append(el('div', { class:'note', text:'Yuklanmoqda…' }));
      try {
        modelCache = await listModels(s);
        render(modelCache);
      } catch (e) {
        list.innerHTML = '';
        list.append(el('div', { class:'note warn', text:e.message }), manual());
      }
    })();

    return wrap;
  });
}

/* --------------------------------------------------------------- roles */

export function openRolePicker(chat, onPick) {
  openSheet(() => [
    el('h3', { text:t('role') }),
    ...allRoles().map(r => el('button', { class:`list-item ${r.id === chat.roleId ? 'sel' : ''}`, onClick:() => {
      chat.roleId = r.id; save(); closeSheet(); onPick?.();
    }},
      el('span', { class:'em', text:r.emoji }),
      el('span', { class:'txt' },
        el('b', { text: r.name }),
        el('small', { text: r.tools ? t('roleToolsSub') : (r.prompt || '').slice(0, 44) })),
      r.id === chat.roleId ? svg(ICON.check, 'class="tick"') : null)),
    el('button', { class:'list-item', onClick:() => openRoleEditor(null, () => openRolePicker(chat, onPick)) },
      el('span', { class:'em', text:'＋' }),
      el('span', { class:'txt' }, el('b', { text:t('newRole') }))),
  ]);
}

export function openRoleEditor(role, after) {
  const isNew = !role;
  const draft = isNew
    ? { id:uid(), emoji:'✨', name:'', prompt:'', tools:false }
    : { ...role };

  openSheet(() => {
    const name = el('input', { value:draft.name, placeholder:t('roleName') });
    const prompt = el('textarea', { placeholder:'For example: answer briefly, with a dry sense of humour.' });
    prompt.value = draft.prompt || '';
    prompt.disabled = !!role?.builtin && role.id === 'builder';

    const emojiPick = el('div', { class:'emoji-grid' });
    const paint = () => {
      emojiPick.innerHTML = '';
      EMOJIS.slice(0, 28).forEach(e => emojiPick.append(
        el('button', { class: e === draft.emoji ? 'on' : '', text:e, onClick:() => { draft.emoji = e; paint(); } })));
    };
    paint();

    return [
      el('h3', { text: isNew ? t('newRole') : draft.name }),
      role?.builtin
        ? el('div', { class:'note', text:'A built-in role. Editing it saves a copy of your own.' })
        : null,
      field(t('roleName'), name),
      field(t('icon'), emojiPick),
      field(t('rolePrompt'), prompt),
      switchRow(t('roleTools'), t('roleToolsSub'), !!draft.tools, v => { draft.tools = v; }),
      el('div', { class:'btn-row' },
        !isNew && !role.builtin
          ? el('button', { class:'btn danger', text:t('delete'), onClick:async () => {
              if (await confirmSheet({ title:t('confirmDelete'), ok:t('delete') })) {
                state.roles = state.roles.filter(r => r.id !== role.id);
                for (const c of state.chats) if (c.roleId === role.id) c.roleId = 'chat';
                save(true); closeSheet(); after?.();
              }
            }})
          : null,
        el('button', { class:'btn primary', text:t('save'), onClick:() => {
            draft.name = name.value.trim() || 'Role';
            draft.prompt = prompt.value;
            if (role?.builtin) {                    // fork rather than mutate
              const copy = { ...draft, id:uid(), builtin:false };
              state.roles.push(copy);
            } else {
              const i = state.roles.findIndex(r => r.id === draft.id);
              i >= 0 ? state.roles[i] = draft : state.roles.push(draft);
            }
            save(true); closeSheet(); after?.();
          }})),
    ];
  });
}

/* ------------------------------------------------------------- publish */

export function openPublish(project, existing, onDone) {
  const draft = {
    id: existing?.id || null,
    name: existing?.name || 'Mini ilova',
    emoji: existing?.emoji || '📱',
    color: existing?.color || PALETTE[0],
    deviceAccess: existing?.deviceAccess || false,
  };

  openSheet(() => {
    const preview = el('div', { class:'app-ico', style:{ background:draft.color }, text:draft.emoji });
    const name = el('input', { value:draft.name, maxlength:'24' });
    name.addEventListener('input', () => { draft.name = name.value; });

    const emojiPick = el('div', { class:'emoji-grid' });
    const colorPick = el('div', { class:'color-grid' });
    const paint = () => {
      emojiPick.innerHTML = ''; colorPick.innerHTML = '';
      EMOJIS.forEach(e => emojiPick.append(el('button', { class:e === draft.emoji ? 'on' : '', text:e,
        onClick:() => { draft.emoji = e; preview.textContent = e; paint(); } })));
      PALETTE.forEach(c => colorPick.append(el('button', { class:c === draft.color ? 'on' : '',
        style:{ background:c }, onClick:() => { draft.color = c; preview.style.background = c; paint(); } })));
    };
    paint();

    return [
      el('h3', { text: existing ? t('update') : t('publish') }),
      el('div', { class:'center', style:{ padding:'4px 0 16px' } }, preview),
      field(t('appName'), name),
      field(t('icon'), emojiPick),
      field(t('color'), colorPick),
      switchRow(t('deviceAccess'), t('deviceWarn'), draft.deviceAccess, async v => {
        if (v && !await confirmSheet({ title:t('deviceAccess'), text:t('deviceWarn'), ok:t('yes') })) {
          draft.deviceAccess = false; closeSheet(); openPublish(project, existing, onDone); return;
        }
        draft.deviceAccess = v;
      }),
      el('div', { class:'btn-row' },
        el('button', { class:'btn primary', text:t('save'), onClick:() => {
          const app = publishApp({ ...draft, files:project.files, assets:project.assets });
          closeSheet(); toast(t('appAdded')); onDone?.(app);
        }})),
    ];
  });
}

/* ----------------------------------------------------- add to home / app menu */

/** Read-only source view. Handy for learning, and for pasting somewhere else. */
export function openCode(files) {
  openSheet(() => [
    el('h3', { text:t('code') }),
    ...Object.entries(files || {}).flatMap(([name, src]) => [
      el('h4', { text:`${name} · ${Math.round(src.length / 102.4) / 10} KB` }),
      el('pre', { class:'code-block' }, el('code', { text:src })),
      el('button', { class:'btn', text:t('copy'), onClick:async () => {
        try { await navigator.clipboard.writeText(src); toast(t('copied')); }
        catch { toast(t('error')); }
      }}),
    ]),
  ]);
}

/** `draft` = not published yet, so there is nothing to share, pin or delete. */
export function openAppMenu(app, { onOpen, onEdit, onChanged, onMarket, onPrint, draft = false } = {}) {
  if (draft) return openSheet(() => [
    el('div', { class:'center', style:{ padding:'4px 0 14px' } },
      el('div', { class:'app-ico', style:{ background:app.color || '#7c8cff', margin:'0 auto' },
        text:app.emoji || '📱' }),
      el('div', { style:{ marginTop:'8px', fontWeight:600 }, text:app.name || 'Ilova' })),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onPrint?.(); } },
      el('span', { class:'em', text:'🖨' }), el('span', { class:'txt' }, el('b', { text:t('print') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); openCode(app.files); } },
      el('span', { class:'em', text:'{ }' }), el('span', { class:'txt' }, el('b', { text:t('code') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onMarket?.(app); } },
      el('span', { class:'em', text:'🚀' }), el('span', { class:'txt' },
        el('b', { text:t('marketPublish') }), el('small', { text:t('marketHow').slice(0, 52) + '…' }))),
    el('div', { class:'note', style:{ marginTop:'10px' },
      text:'Bu ilova hali saqlanmagan. Chatdagi kartadan «Ilova qilib saqlash» ni bosing.' }),
  ]);

  openSheet(() => [
    el('div', { class:'center', style:{ padding:'4px 0 14px' } },
      el('div', { class:'app-ico', style:{ background:app.color, margin:'0 auto' }, text:app.emoji }),
      el('div', { style:{ marginTop:'8px', fontWeight:600 }, text:app.name })),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onOpen?.(); } },
      el('span', { class:'em', text:'▶️' }), el('span', { class:'txt' }, el('b', { text:t('open') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onEdit?.(); } },
      el('span', { class:'em', text:'✏️' }), el('span', { class:'txt' }, el('b', { text:t('edit') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); openAddToHome(app); } },
      el('span', { class:'em', text:'📲' }), el('span', { class:'txt' }, el('b', { text:t('addToHome') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onPrint?.(); } },
      el('span', { class:'em', text:'🖨' }), el('span', { class:'txt' }, el('b', { text:t('print') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); openCode(app.files); } },
      el('span', { class:'em', text:'{ }' }), el('span', { class:'txt' }, el('b', { text:t('code') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onMarket?.(app); } },
      el('span', { class:'em', text:'🚀' }), el('span', { class:'txt' },
        el('b', { text:t('marketPublish') }), el('small', { text:t('marketHow').slice(0, 52) + '…' }))),
    el('button', { class:'list-item', onClick:async () => {
      const url = `${location.origin}${location.pathname}?app=${app.id}`;
      try { await navigator.share({ title:app.name, url }); }
      catch { await navigator.clipboard?.writeText(url); toast(t('copied')); }
      closeSheet();
    }}, el('span', { class:'em', text:'🔗' }), el('span', { class:'txt' }, el('b', { text:t('share') }))),
    el('button', { class:'list-item', onClick:async () => {
      closeSheet();
      if (await confirmSheet({ title:t('confirmDelete'), text:app.name, ok:t('delete') })) {
        deleteApp(app.id); onChanged?.();
      }
    }}, el('span', { class:'em', text:'🗑' }), el('span', { class:'txt' },
        el('b', { class:'', text:t('delete'), style:{ color:'var(--danger)' } }))),
  ]);
}

/** iOS has no install API; Android does. Both end up with a real icon. */
export function openAddToHome(app) {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  openSheet(close => {
    const box = el('div');
    (async () => {
      await applyAppIdentity(app);
      box.innerHTML = '';
      const prompt = window.__miniInstallPrompt;
      if (!ios && prompt) {
        box.append(el('button', { class:'btn primary', text:t('addToHome'), onClick:async () => {
          prompt.prompt();
          await prompt.userChoice.catch(() => {});
          window.__miniInstallPrompt = null;
          close();
        }}));
      } else {
        box.append(el('div', { class:'note', html: ios
          ? `In Safari, tap <b>Share</b> → <b>Add to Home Screen</b>. It is added as <b>${app.name}</b> with its own icon.`
          : `Choose <b>Add to Home screen</b> from the browser menu.` }));
      }
    })();
    return [
      el('h3', { text:t('addToHome') }),
      el('div', { class:'center', style:{ padding:'4px 0 16px' } },
        el('img', { src:iconDataUrl(app.emoji, app.color, 192), width:'64', height:'64',
          style:{ borderRadius:'16px' } })),
      box,
      el('div', { class:'note', style:{ marginTop:'12px' },
        text:'Once added, it opens full screen with its own icon.' }),
    ];
  });
}

/* ---------------------------------------------------------------- theme */

export function applyTheme() {
  const th = state.settings.theme;
  if (th === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
  const bg = getComputedStyle(document.body).backgroundColor;
  const meta = $('meta[name="theme-color"]');
  if (meta && !location.search.includes('app=')) meta.setAttribute('content', bg);
}
