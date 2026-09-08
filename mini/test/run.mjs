/**
 * End-to-end checks for Mini.
 *
 * Everything interesting here happens in a browser — a sandboxed iframe, a
 * service worker, the back button — so the suite drives a real Chromium rather
 * than mocking the parts that actually break. It serves `mini/` itself and
 * talks to test/mock-provider.mjs instead of a paid API.
 *
 *   node test/run.mjs                 (needs playwright available to import)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_PORT = 8899, API_PORT = 8900;
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const BASE = ORIGIN + '/index.html';
const API  = `http://127.0.0.1:${API_PORT}/v1`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-test-'));

/* ------------------------------------------------------------- harness */

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};
const group = name => console.log(`\n${name}`);

const seed = (extra = {}) => ({
  settings: { lang:'uz', apiKey:'sk-mock', baseUrl:API, model:'mock/fast',
              modelName:'Mock Fast', installDismissed:true, theme:'dark' },
  ...extra,
});

/** Creates an account straight through the API, for tests that are not about signing up. */
async function makeAccount(name, username, password = 'olmaqogoz7') {
  const res = await fetch(ORIGIN + '/api/auth/register', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ name, username, password }),
  });
  const body = await res.json();
  if (body.error) throw new Error('akkaunt yaratilmadi: ' + body.error);
  return body;
}

const marketApi = (p, opts) => fetch(ORIGIN + p, opts).then(r => r.json());

/** Builds the scripted calculator through the UI and waits for the artifact. */
async function buildApp(page, prompt = 'Menga kalkulyator yasab ber') {
  await page.fill('#input', prompt);
  await page.click('#btn-send');
  await page.waitForSelector('.artifact', { timeout: 45000 });
  await page.waitForTimeout(500);
}

/* --------------------------------------------------------------- setup */

const web = spawn(process.execPath, [path.join(ROOT, 'server/server.js')],
  { stdio:'ignore', env:{ ...process.env, PORT:String(WEB_PORT), MINI_DATA:DATA,
                          MINI_ADMIN_TOKEN:'test-admin', MINI_REGS_PER_HOUR:'500' } });

const api = spawn(process.execPath, [path.join(ROOT, 'test/mock-provider.mjs')],
  { stdio:'ignore', env:{ ...process.env, MOCK_PORT:String(API_PORT) } });

const done = async () => {
  web.kill(); api.kill();
  await new Promise(r => setTimeout(r, 300));       // let the server finish its last write
  fs.rmSync(DATA, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
};
await new Promise(r => setTimeout(r, 900));

let chromium, devices;
try { ({ chromium, devices } = await import('playwright')); }
catch { console.error('playwright topilmadi. `npm i -D playwright` yoki global o\'rnating.'); done(); process.exit(2); }

const browser = await chromium.launch();
let accountSeq = 0;

const newPage = async (state, account = 'auto') => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const acct = account === 'auto'
    ? await makeAccount('Tester', 'tester' + (accountSeq++))
    : account;
  await ctx.addInitScript(
    `try { localStorage.setItem('mini.v1', ${JSON.stringify(JSON.stringify(state))});` +
    (acct ? ` localStorage.setItem('mini.session', ${JSON.stringify(JSON.stringify(acct))});` : '') +
    ` } catch (e) {}`);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(BASE, { waitUntil:'networkidle' });
  await page.waitForTimeout(400);
  return { page, ctx, errs };
};

/* ----------------------------------------------------- 1. the agent loop */

group('Agent: so\'rovdan ekrandagi ilovagacha');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.fill('#input', 'Menga kalkulyator yasab ber');
  await page.click('#btn-send');
  await page.waitForSelector('.artifact', { timeout: 45000 });
  await page.waitForTimeout(600);

  const steps = await page.locator('.msg.ai .step b').allTextContents();
  ok('fayl yozildi, tekshirildi, saqlandi', steps.length === 3, steps.join(' | '));
  ok('run_check bajarildi', steps.some(s => s.startsWith('Tekshirildi')));

  const st = await page.evaluate(() => JSON.parse(localStorage['mini.v1']));
  ok('ilova saqlandi', st.apps.length === 1 && st.apps[0].name === 'Kalkulyator');
  ok('token hisobi yozildi', st.totals.in > 0 && st.totals.out > 0);
  ok('chat nomi qo\'yildi', !!st.chats[0].title);

  await page.click('#btn-apps'); await page.waitForTimeout(300);
  await page.click('.app-tile'); await page.waitForTimeout(800);
  const f = page.frameLocator('#player-stage iframe');
  for (const k of ['7', '+', '5', '=']) await f.locator('button', { hasText: k }).click();
  await page.waitForTimeout(300);
  ok('yasalgan ilova hisoblaydi (7+5)', (await f.locator('#out').textContent()) === '12');

  await page.waitForTimeout(400);
  const kept = await page.evaluate(() => Object.keys(localStorage)
    .filter(k => k.startsWith('mini.appdata.') && !k.endsWith('__check__'))
    .map(k => localStorage.getItem(k)));
  ok('ilova localStorage ko\'prigi saqlaydi', kept.some(v => v.includes('"12"')), kept.join());
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* -------------------------------------------------------- 2. the sandbox */

group('Sandbox: izolyatsiya, o\'z-o\'zini test, surat');
{
  const { page, ctx, errs } = await newPage(seed());
  const r = await page.evaluate(async () => {
    const { runCheck, formatCheck, compose } = await import('./js/sandbox.js');
    const project = {
      files: {
        'index.html': `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
<body><h1>Salom</h1><p>localStorage haqida matn.</p><button onclick="bump()">Bos</button>
<div id="o"></div><script src="app.js"><\/script></body></html>`,
        'style.css': 'h1{color:#345}',
        'app.js': `function bump(){ var n=(+localStorage.getItem('n')||0)+1;
          localStorage.setItem('n',n); document.getElementById('o').textContent='n='+n; }`,
      },
      assets: [],
    };
    const composed = compose(project);
    const check = await runCheck(project, { interact:true, shot:true });
    const broken = await runCheck({ files:{ 'index.html':
      '<!doctype html><html><body><script>notDefined()<\/script></body></html>' }, assets:[] }, {});
    return {
      composed, report: formatCheck(check), shot: check.shot?.length || 0,
      brokenReport: formatCheck(broken), clicked: check.clicked,
    };
  });

  ok('CSS ichkariga joylandi', r.composed.includes('h1{color:#345}'));
  ok('JS ichkariga joylandi', r.composed.includes('function bump'));
  ok('storage identifikatori almashtirildi', r.composed.includes('__miniLS.getItem'));
  ok('sahifadagi matnga tegilmadi', r.composed.includes('localStorage haqida matn'));
  ok('tugmalar bosib ko\'rildi', r.clicked >= 1, String(r.clicked));
  ok('sog\'lom ilovada xato yo\'q', r.report.includes('Xato yo\'q'), r.report);
  ok('siniq ilovada xato topildi', /XATOLAR/.test(r.brokenReport), r.brokenReport);
  ok('ekran surati olindi', r.shot > 1000, String(r.shot));
  // The broken project above throws on purpose; nothing else should.
  ok('faqat ataylab siniq ilova xato berdi',
     errs.every(e => /notDefined/.test(e)), errs.join(' | '));
  await ctx.close();
}

/* ---------------------------------------------------------- 3. vision */

group('Ko\'rish: surat modelga qaytadi');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.fill('#input', 'Kalkulyator yasab, suratini olib tekshir');
  await page.click('#btn-send');
  await page.waitForSelector('.artifact', { timeout: 45000 });
  await page.waitForTimeout(500);

  const steps = await page.locator('.msg.ai .step b').allTextContents();
  ok('screenshot qadami bor', steps.some(s => s.includes('surat')), steps.join(' | '));

  const last = JSON.parse(fs.readFileSync(new URL('./last-request.json', import.meta.url), 'utf8'));
  ok('rasm modelga image_url sifatida yuborildi',
     last.imgs.some(u => u.startsWith('data:image/jpeg')), JSON.stringify(last.imgs));
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ----------------------------------------- 4. installable per-app manifest */

group('Ekranga qo\'shish: har bir ilovaga alohida manifest');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(300);

  const r = await page.evaluate(async () => {
    const { applyAppIdentity, restoreIdentity } = await import('./js/icons.js');
    await applyAppIdentity({ id:'demo', name:'Kalkulyator', emoji:'🧮', color:'#22c55e' });
    const href = document.querySelector('#manifest-link').getAttribute('href');
    const res = await fetch(href);
    const body = await res.json();
    const icon = await fetch(body.icons[0].src);
    const live = { title: document.title, apple: document.querySelector('#apple-icon').getAttribute('href') };
    restoreIdentity();
    return { ok: res.ok, type: res.headers.get('content-type'), body,
             iconOk: icon.ok, iconBytes: (await icon.blob()).size, live,
             restored: document.title };
  });

  ok('manifest service worker orqali berildi', r.ok && /manifest/.test(r.type), r.type);
  ok('start_url ilovaga ishora qiladi', r.body.start_url.includes('?app=demo'), r.body.start_url);
  ok('standalone rejim', r.body.display === 'standalone');
  ok('PNG belgi berildi', r.iconOk && r.iconBytes > 500, String(r.iconBytes));
  ok('iOS uchun sarlavha va belgi almashtirildi',
     r.live.title === 'Kalkulyator' && r.live.apple.startsWith('data:image/png'));
  ok('chiqqanda o\'z nomi qaytdi', r.restored === 'Mini');
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------- 5. back button */

group('Orqaga tugmasi: har qatlam o\'z navbatida yopiladi');
{
  const app = { id:'a1', name:'Test', emoji:'🧮', color:'#22c55e',
    files:{ 'index.html':'<!doctype html><html><body><h1>Salom</h1></body></html>' },
    assets:[], createdAt:1, updatedAt:1 };
  const { page, ctx, errs } = await newPage(seed({ apps:[app] }));
  const vis = async () => ({
    drawer: await page.isVisible('#drawer'), apps: await page.isVisible('#apps-screen'),
    player: await page.isVisible('#player'), sheet: await page.isVisible('#sheet-wrap'),
    alive:  await page.isVisible('#composer'),
  });
  const back = async () => { await page.goBack(); await page.waitForTimeout(250); };

  await page.click('#btn-menu'); await page.waitForTimeout(250);
  await back();
  ok('drawer yopildi', !(await vis()).drawer);

  await page.click('#btn-apps'); await page.waitForTimeout(250);
  await page.click('.app-tile'); await page.waitForTimeout(600);
  await back();
  let v = await vis();
  ok('ilova yopildi, ro\'yxat qoldi', !v.player && v.apps);
  await back();
  ok('ro\'yxat yopildi', !(await vis()).apps);

  await page.click('#btn-menu'); await page.waitForTimeout(200);
  await page.click('#btn-settings'); await page.waitForTimeout(300);
  await back();
  v = await vis();
  ok('sheet yopildi, drawer qoldi', !v.sheet && v.drawer);
  await back();
  v = await vis();
  ok('drawer yopildi, ilovadan chiqib ketilmadi', !v.drawer && v.alive);
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------ 6. accounts */

group('Akkaunt: ro\'yxatdan o\'tish, kirish, chiqish');
{
  const { page, ctx, errs } = await newPage(seed(), null);   // no session
  ok('kirish ekrani ko\'rsatildi', await page.isVisible('#auth-screen'));
  ok('ilova yopiq', !(await page.isVisible('#composer')));

  await page.click('#auth-tab-register');
  await page.fill('#auth-name', 'Sarvarbek');
  await page.fill('#auth-username', 'sarvarbek');
  await page.fill('#auth-password', 'olmaqogoz7');
  await page.click('#auth-submit');
  await page.waitForSelector('#composer', { state:'visible', timeout: 15000 });
  ok('ro\'yxatdan o\'tib ichkariga kirdi', await page.isVisible('#composer'));
  ok('kirish ekrani yopildi', !(await page.isVisible('#auth-screen')));

  await page.click('#btn-menu'); await page.waitForTimeout(300);
  ok('drawerda akkaunt ko\'rinadi', (await page.textContent('#account-name')) === 'Sarvarbek');
  ok('username ko\'rinadi', (await page.textContent('#account-handle')) === '@sarvarbek');

  await page.click('#btn-account'); await page.waitForTimeout(350);
  const acctSheet = await page.textContent('#sheet-body');
  ok('akkaunt oynasida chegara ko\'rinadi', acctSheet.includes('kun qoldi'), acctSheet.slice(0, 80));
  ok('faolsizlik qoidasi yozilgan', acctSheet.includes('30 kun'));

  // a reload keeps the session
  await page.reload({ waitUntil:'networkidle' });
  await page.waitForTimeout(700);
  ok('sessiya saqlandi', await page.isVisible('#composer'));
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Akkaunt: noto\'g\'ri parol va o\'rnatilgan ilova');
{
  const { page, ctx } = await newPage(seed(), null);
  await page.fill('#auth-username', 'sarvarbek');
  await page.fill('#auth-password', 'notogri');
  await page.click('#auth-submit');
  await page.waitForSelector('#auth-error', { state:'visible', timeout: 15000 });
  ok('noto\'g\'ri parol rad etildi', (await page.textContent('#auth-error')).includes('noto'));
  ok('ichkariga kirmadi', !(await page.isVisible('#composer')));
  await ctx.close();

  // A mini app already on the home screen must open without an account.
  const app = { id:'local1', name:'Mahalliy', emoji:'🧮', color:'#E8171F',
    files:{ 'index.html':'<!doctype html><html><body><h1 id="h">Salom</h1></body></html>' },
    assets:[], createdAt:1, updatedAt:1 };
  const { page: p2, ctx: c2 } = await newPage(seed({ apps:[app] }), null);
  await p2.goto(`${ORIGIN}/?app=local1`, { waitUntil:'networkidle' });
  await p2.waitForTimeout(900);
  ok('o\'rnatilgan ilova akkauntsiz ochiladi', await p2.isVisible('#player'));
  ok('kirish so\'ralmadi', !(await p2.isVisible('#auth-screen')));
  await c2.close();
}

/* ------------------------------------------------------------- 7. market */

group('Market: tekshiruv, joylash, kunlik chegara');
let publishedId = null;
{
  const { page, ctx, errs } = await newPage(seed());
  await buildApp(page);

  await page.click('.artifact .btn.dark');                 // "Marketga joylash"
  await page.waitForTimeout(300);
  ok('joylash oynasi ochildi', (await page.textContent('#sheet-body h3')).includes('Marketga'));

  await page.click('#sheet-body .btn.primary');            // start the AI review
  await page.waitForSelector('.verdict', { timeout: 30000 });
  ok('AI tekshiruvi o\'tdi', await page.isVisible('.verdict.ok'));
  ok('kategoriya aniqlandi', (await page.textContent('.verdict')).includes('Asboblar'));

  await page.click('#sheet-body .btn.primary');            // submit
  await page.waitForSelector('.note.ok', { timeout: 20000 });
  ok('serverga joylandi', (await page.textContent('.note.ok')).includes('marketda'));

  const cat = await marketApi('/api/market/index.json');
  publishedId = cat.apps[0]?.id;
  ok('katalogda paydo bo\'ldi', cat.apps.length === 1 && cat.apps[0].name === 'Kalkulyator',
     JSON.stringify(cat.apps.map(a => a.name)));
  ok('kategoriya yaratildi', cat.categories[0]?.id === 'asboblar', JSON.stringify(cat.categories));
  ok('muallif saqlandi', cat.apps[0]?.author === 'Tester');

  // second publish, same device, same day
  await page.click('#sheet-body .btn.primary');            // closes the sheet
  await page.waitForTimeout(300);
  await page.click('.artifact .btn.dark');
  await page.waitForTimeout(400);
  ok('kunlik chegara ushlandi', (await page.textContent('#sheet-body')).includes('Kuniga bitta'));
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Market: boshqa foydalanuvchi o\'rnatadi');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.click('#tab-market');
  await page.waitForSelector('.mk-row', { timeout: 20000 });
  ok('ro\'yxatda ko\'rinadi', (await page.textContent('.mk-row b')) === 'Kalkulyator');

  await page.click('.mk-row .mk-get');                     // OLISH
  await page.waitForTimeout(1500);
  const apps = await page.evaluate(() => JSON.parse(localStorage['mini.v1']).apps);
  ok('ilova o\'rnatildi', apps.length === 1 && apps[0].marketId === publishedId,
     JSON.stringify(apps.map(a => a.marketId)));
  ok('fayllar yuklandi', !!apps[0]?.files?.['index.html']);
  ok('ekranga qo\'shish taklif qilindi', await page.isVisible('#sheet-wrap'));

  await page.waitForTimeout(3400);            // counts are coalesced server-side
  const cat = await marketApi('/api/market/index.json');
  ok('o\'rnatish soni ortdi', cat.apps[0].installs >= 1, String(cat.apps[0].installs));
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Market: ulashilgan havola va server tekshiruvi');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.goto(`${ORIGIN}/?m=${publishedId}`, { waitUntil:'networkidle' });
  await page.waitForSelector('#sheet-body .stat-row', { timeout: 20000 });
  ok('havola ilova sahifasini ochdi', (await page.textContent('#sheet-body h3')) === 'Kalkulyator');
  ok('market ko\'rinishiga o\'tdi', await page.isVisible('#view-market'));
  ok('manzil tozalandi', !page.url().includes('?m='));
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();

  const post = (body, token) => fetch(ORIGIN + '/api/market/submit', {
    method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token },
    body: JSON.stringify(body) }).then(async r => ({ status:r.status, body: await r.json() }));

  const anon = await fetch(ORIGIN + '/api/market/submit', { method:'POST',
    headers:{ 'Content-Type':'application/json' }, body:'{}' });
  ok('akkauntsiz joylab bo\'lmaydi', anon.status === 401, String(anon.status));

  const good = { name:'Tashqi', emoji:'🧪', color:'#E8171F', review:{ ok:true, category:'test' },
    files:{ 'index.html':'<!doctype html><html><body>' + 'x'.repeat(300) +
      '<script src="https://cdn.example.com/a.js"><\/script></body></html>' } };
  const r1 = await post(good, (await makeAccount('Val A', 'valid_a')).token);
  ok('tashqi skriptli ilova rad etildi', r1.status === 400 && /mustaqil/.test(r1.body.error), JSON.stringify(r1));

  const r2 = await post({ ...good, files:{ 'index.html':'<html><body>hi</body></html>' } },
    (await makeAccount('Val B', 'valid_b')).token);
  ok('bo\'sh ilova rad etildi', r2.status === 400, JSON.stringify(r2));

  const r3 = await post({ ...good, review:{ ok:false },
    files:{ 'index.html':'<!doctype html><html><body>' + 'y'.repeat(300) + '</body></html>' } },
    (await makeAccount('Val C', 'valid_c')).token);
  ok('tekshiruvsiz ilova rad etildi', r3.status === 400 && /tekshiruv/.test(r3.body.error), JSON.stringify(r3));
}

/* --------------------------------------------- 9. the inactivity rule */

group('Faolsiz akkauntlar o\'chiriladi');
{
  const { Auth } = await import(path.join(ROOT, 'server/auth.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-auth-'));
  const a = new Auth(dir, { inactiveDays: 30 });

  a.register({ name:'Faol', username:'faol', password:'olmaqogoz7' });
  a.register({ name:'Eski', username:'eski', password:'olmaqogoz7' });
  const stale = a.users.find(u => u.username === 'eski');
  stale.lastSeen = Date.now() - 31 * 86_400_000;

  ok('30 kunlik jimlikdan keyin 0 kun qoladi', a.daysLeft(stale) === 0, String(a.daysLeft(stale)));
  const removed = a.sweep();
  ok('faolsiz akkaunt o\'chdi', removed.length === 1 && a.users.length === 1, JSON.stringify(removed));
  ok('faol akkaunt qoldi', a.users[0].username === 'faol');
  ok('o\'chgan username qayta band emas', !a.byName.has('eski'));

  // the file on disk agrees with memory
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  ok('diskda ham o\'chdi', onDisk.length === 1 && onDisk[0].username === 'faol');

  // tokens survive a restart, forged ones never work
  const token = a.issue(a.users[0]);
  const b = new Auth(dir, { inactiveDays: 30 });
  ok('token qayta ishga tushirishdan keyin ham ishlaydi', b.verify(token)?.username === 'faol');
  ok('soxta token ishlamaydi', b.verify(token.slice(0, -1) + 'x') === null);
  ok('parol tekshiruvi ishlaydi',
     !!b.login({ username:'faol', password:'olmaqogoz7', ip:'1.1.1.1' }).user &&
     !!b.login({ username:'faol', password:'boshqa', ip:'2.2.2.2' }).error);

  // changing the password must not leave the old session usable
  const old = b.issue(b.users[0]);
  b.changePassword(b.users[0], { current:'olmaqogoz7', next:'yangiparol9' });
  ok('parol o\'zgarsa eski sessiya o\'ladi', b.verify(old) === null);
  ok('yangi parol ishlaydi', !!b.login({ username:'faol', password:'yangiparol9', ip:'3.3.3.3' }).user);

  // sign-ups are capped per address, and the cap is per address
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-auth2-'));
  process.env.MINI_REGS_PER_HOUR = '3';
  const { Auth: Auth2 } = await import(path.join(ROOT, 'server/auth.js') + '?cap');
  const c = new Auth2(dir2, {});
  const tries = [1, 2, 3, 4].map(i =>
    c.register({ name:'Yangi', username:'yangi' + i, password:'olmaqogoz7', ip:'9.9.9.9' }));
  ok('soatiga cheklangan ro\'yxatdan o\'tish', !!tries[3].error && !tries[2].error,
     JSON.stringify(tries.map(t => t.error || 'ok')));
  ok('boshqa manzil bloklanmaydi',
     !c.register({ name:'Yangi', username:'boshqa1', password:'olmaqogoz7', ip:'8.8.8.8' }).error);
  fs.rmSync(dir2, { recursive:true, force:true });
  fs.rmSync(dir, { recursive:true, force:true });
}

/* ------------------------------------------------ 10. translation tables */

group('Tarjima jadvallari');
{
  const src = fs.readFileSync(path.join(ROOT, 'js/i18n.js'), 'utf8');
  const blocks = [...src.matchAll(/^  (uz|en|ru): \{$([\s\S]*?)^  \},$/gm)];
  ok('uchta til bor', blocks.length === 3, String(blocks.length));

  // Nested tables (steps:{…}) carry their own key names; flatten them out
  // before looking for duplicates at the top level.
  const keysOf = body => [...body.replace(/\w+:\s*\{[^{}]*\}/g, 'nested:0')
    .matchAll(/(?:^|[,{]\s*)\n?\s*([a-zA-Z]\w*):/g)].map(m => m[1]);
  const sets = blocks.map(([, lang, body]) => {
    const keys = keysOf(body);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    // A repeated key silently wins in a JS object literal, and the loser is
    // usually the new one — a whole string quietly reverting to something else.
    ok(`${lang}: takrorlangan kalit yo'q`, dupes.length === 0, [...new Set(dupes)].join(', '));
    return new Set(keys);
  });

  const [uz, en, ru] = sets;
  const missing = (a, b, an, bn) => [...a].filter(k => !b.has(k))
    .map(k => `${bn} da yo'q: ${k}`);
  const gaps = [...missing(uz, en, 'uz', 'en'), ...missing(uz, ru, 'uz', 'ru')];
  ok('barcha kalitlar uchala tilda bor', gaps.length === 0, gaps.slice(0, 6).join(' | '));
}

/* ------------------------------------------------------------- results */

await browser.close();
await done();
console.log(`\n${pass} ta o'tdi, ${fail} ta yiqildi.`);
process.exit(fail ? 1 : 0);
