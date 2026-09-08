/** Every modal in the app. Bottom sheets, because thumbs live at the bottom. */

import { state, save, allRoles, uid, storageBytes, deleteApp, publishApp } from '../store.js';
import { t } from '../i18n.js';
import { listModels } from '../llm.js';
import { PALETTE, EMOJIS, iconDataUrl, applyAppIdentity } from '../icons.js';
import { $, el, openSheet, closeSheet, confirmSheet, switchRow, field, toast, fmtBytes,
         ICON, svg, iconTile } from './dom.js';

const PROVIDERS = [
  ['OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/keys'],
  ['Gemini',     'https://generativelanguage.googleapis.com/v1beta/openai', 'https://aistudio.google.com/apikey'],
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
    const provRow = el('div', { class:'chips left' }, ...PROVIDERS.map(p =>
      el('button', { class:`chip sm ${p === provider ? 'on' : ''}`, text:p[0], onClick:() => {
        if (p[1]) { s.baseUrl = p[1]; modelCache = null; save(); }
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
        iconTile(ICON.sparkle),
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
        iconTile(ICON.plus),
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

/**
 * The model picker.
 *
 * Hundreds of models arrive in one list, so the work is narrowing: a search
 * that filters as you type, three filters that cover what people actually
 * choose on (free, cheap, can see pictures), and rows grouped by vendor so a
 * familiar name is findable without knowing its exact id.
 */
export function openModels(afterChange) {
  const s = state.settings;
  let filter = 'all';

  openSheet(() => {
    const search = el('input', { type:'search', placeholder:t('searchModel'),
      autocapitalize:'off', spellcheck:'false' });
    const list = el('div');
    const chips = el('div', { class:'chips left', style:{ marginBottom:'10px' } });
    const head = el('div', { class:'model-search' },
      el('div', { class:'search' }, svg(ICON.search), search), chips);

    const manual = () => {
      const inp = el('input', { value:s.model, placeholder:'e.g. openai/gpt-4o-mini' });
      inp.addEventListener('change', () => {
        s.model = inp.value.trim(); s.modelName = s.model; save(true); afterChange?.(); toast(t('done'));
      });
      return field('Model id (by hand)', inp);
    };

    const FILTERS = [['all', 'All'], ['free', 'Free'], ['cheap', 'Under $1/M'], ['vision', 'Sees images']];

    const render = () => {
      const rows = modelCache || [];
      chips.innerHTML = '';
      for (const [id, label] of FILTERS) {
        chips.append(el('button', { class:`chip sm ${filter === id ? 'on' : ''}`, text:label,
          onClick:() => { filter = id; render(); } }));
      }

      const q = search.value.toLowerCase().trim();
      const shown = rows.filter(m =>
        (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) &&
        (filter !== 'free'   || m.free) &&
        (filter !== 'cheap'  || m.free || (m.priceIn && m.priceIn <= 1)) &&
        (filter !== 'vision' || m.vision)).slice(0, 140);

      list.innerHTML = '';
      if (!shown.length) { list.append(el('div', { class:'note', text:t('noModels') })); return; }

      let vendor = null;
      for (const m of shown) {
        if (m.vendor !== vendor) {
          vendor = m.vendor;
          list.append(el('div', { class:'chat-group', text:vendor }));
        }
        const price = m.free ? 'free'
          : m.priceIn ? `$${m.priceIn < 1 ? m.priceIn.toFixed(2) : m.priceIn.toFixed(1)} in · $${m.priceOut.toFixed(m.priceOut < 1 ? 2 : 1)} out per 1M`
          : '';
        list.append(el('button', { class:`list-item ${m.id === s.model ? 'sel' : ''}`, onClick:() => {
          s.model = m.id; s.modelName = m.name; save(true); afterChange?.(); closeSheet(); toast(m.name);
        }},
          iconTile(m.vision ? ICON.image : ICON.sparkle, m.free ? 'red' : ''),
          el('span', { class:'txt' },
            el('b', { text:m.name.replace(/^[^:]+:\s*/, '') }),
            el('small', { text:[price, m.ctx ? `${Math.round(m.ctx / 1000)}k context` : '']
              .filter(Boolean).join(' · ') })),
          m.id === s.model ? svg(ICON.check, 'class="tick"') : null));
      }
    };

    search.addEventListener('input', () => modelCache && render());

    (async () => {
      if (modelCache) return render();
      list.append(el('div', { class:'center', style:{ padding:'30px 0' } }, el('span', { class:'spinner' })));
      try {
        modelCache = await listModels(s);
        render();
      } catch (e) {
        list.innerHTML = '';
        list.append(el('div', { class:'note warn', text:e.message }), manual());
      }
    })();

    return [el('h3', { text:t('chooseModel') }), head, list];
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
      iconTile(ICON.plus),
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
      el('div', { style:{ marginTop:'8px', fontWeight:600 }, text:app.name || 'App' })),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onPrint?.(); } },
      iconTile(ICON.printer), el('span', { class:'txt' }, el('b', { text:t('print') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); openCode(app.files); } },
      iconTile(ICON.code), el('span', { class:'txt' }, el('b', { text:t('code') }))),
    el('div', { class:'note', style:{ marginTop:'10px' },
      text:'Not saved yet. Use “Save as app” on the card in the chat.' }),
  ]);

  openSheet(() => [
    el('div', { class:'center', style:{ padding:'4px 0 14px' } },
      el('div', { class:'app-ico', style:{ background:app.color, margin:'0 auto' }, text:app.emoji }),
      el('div', { style:{ marginTop:'8px', fontWeight:600 }, text:app.name })),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onOpen?.(); } },
      iconTile(ICON.play), el('span', { class:'txt' }, el('b', { text:t('open') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onEdit?.(); } },
      iconTile(ICON.pencil), el('span', { class:'txt' }, el('b', { text:t('edit') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); openAddToHome(app); } },
      iconTile(ICON.download, 'red'), el('span', { class:'txt' }, el('b', { text:t('addToHome') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onPrint?.(); } },
      iconTile(ICON.printer), el('span', { class:'txt' }, el('b', { text:t('print') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); openCode(app.files); } },
      iconTile(ICON.code), el('span', { class:'txt' }, el('b', { text:t('code') }))),
    el('button', { class:'list-item', onClick:() => { closeSheet(); onMarket?.(app); } },
      iconTile(ICON.rocket, 'red'), el('span', { class:'txt' },
        el('b', { text:t('marketPublish') }), el('small', { text:'Let others install it' }))),
    el('button', { class:'list-item', onClick:async () => {
      const url = `${location.origin}${location.pathname}?app=${app.id}`;
      try { await navigator.share({ title:app.name, url }); }
      catch { await navigator.clipboard?.writeText(url); toast(t('copied')); }
      closeSheet();
    }}, iconTile(ICON.link), el('span', { class:'txt' }, el('b', { text:t('share') }))),
    el('button', { class:'list-item', onClick:async () => {
      closeSheet();
      if (await confirmSheet({ title:t('confirmDelete'), text:app.name, ok:t('delete') })) {
        deleteApp(app.id); onChanged?.();
      }
    }}, iconTile(ICON.trash, 'danger'), el('span', { class:'txt' },
        el('b', { text:t('delete'), style:{ color:'var(--danger)' } }))),
  ]);
}

/**
 * Getting one mini app onto the phone's home screen.
 *
 * There is no API that adds a second app: `beforeinstallprompt` fires once,
 * for the page's original manifest, and never again after it is swapped. So
 * this hands the browser the right manifest and then says plainly which menu
 * item to use — and, from inside an already-installed app where that menu does
 * not exist at all, says to open the link in a browser first and offers it.
 */
export function openAddToHome(app) {
  const ua = navigator.userAgent;
  const ios = /iP(hone|ad|od)/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const url = `${location.origin}${location.pathname}?app=${app.id}`;

  const copyRow = () => el('button', { class:'btn', onClick:async () => {
    try { await navigator.clipboard.writeText(url); toast(t('copied')); }
    catch { toast(url); }
  }}, svg(ICON.link), 'Copy link');

  openSheet(close => {
    const box = el('div');

    (async () => {
      await applyAppIdentity(app);          // the browser menu uses this manifest
      box.innerHTML = '';

      if (standalone) {
        box.append(
          el('div', { class:'note warn',
            text:'You are inside the installed app, where the browser has no “add to home screen” menu. Open this link in Chrome or Safari, then add it from there.' }),
          el('div', { class:'btn-row' },
            copyRow(),
            el('button', { class:'btn primary', onClick:() => { window.open(url, '_blank'); close(); } },
              svg(ICON.external), 'Open in browser')));
        return;
      }

      const prompt = window.__miniInstallPrompt;
      if (!ios && prompt) {
        box.append(el('button', { class:'btn primary', onClick:async () => {
          prompt.prompt();
          await prompt.userChoice.catch(() => {});
          window.__miniInstallPrompt = null;
          close();
        }}, svg(ICON.download), t('addToHome')));
        return;
      }

      box.append(
        el('div', { class:'note', html: ios
          ? 'Tap <b>Share</b> at the bottom of Safari, then <b>Add to Home Screen</b>. ' +
            `It is added as <b>${app.name}</b> with its own icon.`
          : 'Open the browser menu (<b>⋮</b>, top right) and choose <b>Add to Home screen</b>. ' +
            `It is added as <b>${app.name}</b> with its own icon.` }),
        el('div', { class:'btn-row' }, copyRow()));
    })();

    return [
      el('h3', { text:t('addToHome') }),
      el('div', { class:'center', style:{ padding:'4px 0 16px' } },
        el('img', { src:iconDataUrl(app.emoji, app.color, 192, app.iconImage), width:'72', height:'72',
          style:{ borderRadius:'19px' } }),
        el('div', { style:{ marginTop:'9px', fontWeight:600 }, text:app.name })),
      box,
      el('div', { class:'note', style:{ marginTop:'12px' },
        text:'Once added it opens full screen, with its own icon, and works offline.' }),
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
