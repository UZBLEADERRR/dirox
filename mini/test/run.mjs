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
// Random ports: a crashed previous run must never make the next one fail.
const WEB_PORT = 8800 + Math.floor(Math.random() * 400);
const API_PORT = WEB_PORT + 400;
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
  settings: { apiKey:'sk-mock', baseUrl:API, model:'mock/fast',
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
  if (body.error) throw new Error('could not create an account: ' + body.error);
  return body;
}

const marketApi = (p, opts) => fetch(ORIGIN + p, opts).then(r => r.json());

/** Builds the scripted calculator through the UI and waits for the artifact. */
async function buildApp(page, prompt = 'build me a calculator') {
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
    ? await makeAccount('Tester', 'tester' + (accountSeq++) + Math.random().toString(36).slice(2, 6))
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

group('Agent: from a sentence to an app on the screen');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.fill('#input', 'build me a calculator');
  await page.click('#btn-send');
  await page.waitForSelector('.artifact', { timeout: 45000 });
  await page.waitForTimeout(600);

  const steps = await page.locator('.msg.ai .step b').allTextContents();
  ok('wrote, checked, published', steps.length === 3, steps.join(' | '));
  ok('run_check ran', steps.some(s => s.startsWith('Checked')));

  const st = await page.evaluate(() => JSON.parse(localStorage['mini.v1']));
  ok('the app was saved', st.apps.length === 1 && st.apps[0].name === 'Calculator');
  ok('token usage recorded', st.totals.in > 0 && st.totals.out > 0);
  ok('the chat got a title', !!st.chats[0].title);

  await page.click('#btn-apps'); await page.waitForTimeout(300);
  await page.click('.app-tile'); await page.waitForTimeout(800);
  const f = page.frameLocator('#player-stage iframe');
  for (const k of ['7', '+', '5', '=']) await f.locator('button', { hasText: k }).click();
  await page.waitForTimeout(300);
  ok('the built app computes 7+5', (await f.locator('#out').textContent()) === '12');

  await page.waitForTimeout(400);
  const kept = await page.evaluate(() => Object.keys(localStorage)
    .filter(k => k.startsWith('mini.appdata.') && !k.endsWith('__check__'))
    .map(k => localStorage.getItem(k)));
  ok('the storage bridge persists', kept.some(v => v.includes('"12"')), kept.join());
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* -------------------------------------------------------- 2. the sandbox */

group('Sandbox: isolation, self-test, screenshot');
{
  const { page, ctx, errs } = await newPage(seed());
  const r = await page.evaluate(async () => {
    const { runCheck, formatCheck, compose } = await import('./js/sandbox.js');
    const project = {
      files: {
        'index.html': `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
<body><h1>Salom</h1><p>Some text about localStorage.</p><button onclick="bump()">Bos</button>
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

  ok('CSS was inlined', r.composed.includes('h1{color:#345}'));
  ok('JS was inlined', r.composed.includes('function bump'));
  ok('storage identifier rewritten', r.composed.includes('__miniLS.getItem'));
  ok('prose left alone', r.composed.includes('text about localStorage'));
  ok('controls were clicked', r.clicked >= 1, String(r.clicked));
  ok('a healthy app reports no errors', r.report.includes('No errors'), r.report);
  ok('a broken app is caught', /ERRORS/.test(r.brokenReport), r.brokenReport);
  ok('screenshot taken', r.shot > 1000, String(r.shot));
  // The broken project above throws on purpose; nothing else should.
  ok('only the deliberately broken app threw',
     errs.every(e => /notDefined/.test(e)), errs.join(' | '));
  await ctx.close();
}

/* ---------------------------------------------------------- 3. vision */

group('Vision: the screenshot goes back to the model');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.fill('#input', 'build a calculator and take a screenshot of it');
  await page.click('#btn-send');
  await page.waitForSelector('.artifact', { timeout: 45000 });
  await page.waitForTimeout(500);

  const steps = await page.locator('.msg.ai .step b').allTextContents();
  ok('the screenshot step ran', steps.some(s => s.includes('Screenshot')), steps.join(' | '));

  const last = JSON.parse(fs.readFileSync(new URL('./last-request.json', import.meta.url), 'utf8'));
  ok('the image went back as image_url',
     last.imgs.some(u => u.startsWith('data:image/jpeg')), JSON.stringify(last.imgs));
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ----------------------------------------- 4. installable per-app manifest */

group('Home screen: a manifest per app');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(300);

  const r = await page.evaluate(async () => {
    const { applyAppIdentity, restoreIdentity } = await import('./js/icons.js');
    await applyAppIdentity({ id:'demo', name:'Calculator', emoji:'🧮', color:'#22c55e' });
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

  ok('served by the service worker', r.ok && /manifest/.test(r.type), r.type);
  ok('start_url is the app\'s own address', r.body.start_url.endsWith('/a/demo/'), r.body.start_url);
  ok('so is its scope and id', r.body.scope === r.body.start_url && r.body.id === r.body.start_url,
     `${r.body.scope} / ${r.body.id}`);
  ok('standalone display', r.body.display === 'standalone');
  ok('a real PNG icon', r.iconOk && r.iconBytes > 500, String(r.iconBytes));
  ok('iOS title and icon swapped in',
     r.live.title === 'Calculator' && r.live.apple.startsWith('data:image/png'));
  ok('the shell takes its name back', r.restored === 'Mini');
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------- 5. back button */

group('Back button: one layer at a time');
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
  ok('the drawer closed', !(await vis()).drawer);

  await page.click('#btn-apps'); await page.waitForTimeout(250);
  await page.click('.app-tile'); await page.waitForTimeout(600);
  await back();
  let v = await vis();
  ok('the app closed, the grid stayed', !v.player && v.apps);
  await back();
  ok('the grid closed', !(await vis()).apps);

  await page.click('#btn-menu'); await page.waitForTimeout(200);
  await page.click('#btn-settings'); await page.waitForTimeout(300);
  await back();
  v = await vis();
  ok('the sheet closed, the drawer stayed', !v.sheet && v.drawer);
  await back();
  v = await vis();
  ok('the drawer closed without leaving the app', !v.drawer && v.alive);
  ok('konsolda xato yo\'q', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------ 6. accounts */

group('Accounts: sign up, sign in, sign out');
{
  const { page, ctx, errs } = await newPage(seed(), null);   // no session
  ok('the sign-in screen is shown', await page.isVisible('#auth-screen'));
  ok('the app is closed', !(await page.isVisible('#composer')));

  await page.click('#auth-tab-register');
  await page.fill('#auth-name', 'Sarvarbek');
  await page.fill('#auth-username', 'sarvarbek');
  await page.fill('#auth-password', 'olmaqogoz7');
  await page.click('#auth-submit');
  await page.waitForSelector('#composer', { state:'visible', timeout: 15000 });
  ok('signing up gets you in', await page.isVisible('#composer'));
  ok('the sign-in screen closed', !(await page.isVisible('#auth-screen')));

  await page.click('#btn-menu'); await page.waitForTimeout(300);
  ok('the drawer shows the account', (await page.textContent('#account-name')) === 'Sarvarbek');
  ok('the handle is shown', (await page.textContent('#account-handle')) === '@sarvarbek');

  await page.click('#btn-account'); await page.waitForTimeout(350);
  const acctSheet = await page.textContent('#sheet-body');
  ok('the account sheet shows the countdown', acctSheet.includes('days left'), acctSheet.slice(0, 80));
  ok('the inactivity rule is stated', acctSheet.includes('30 days'));

  // a reload keeps the session
  await page.reload({ waitUntil:'networkidle' });
  await page.waitForTimeout(700);
  ok('the session survived a reload', await page.isVisible('#composer'));
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Accounts: wrong password, and an installed app');
{
  const { page, ctx } = await newPage(seed(), null);
  await page.fill('#auth-username', 'sarvarbek');
  await page.fill('#auth-password', 'wrongone');
  await page.click('#auth-submit');
  await page.waitForSelector('#auth-error', { state:'visible', timeout: 15000 });
  ok('a wrong password is refused', (await page.textContent('#auth-error')).includes('Wrong'));
  ok('it did not let us in', !(await page.isVisible('#composer')));
  await ctx.close();

  // A mini app already on the home screen must open without an account.
  const app = { id:'local1', name:'Local', emoji:'🧮', color:'#E8171F',
    files:{ 'index.html':'<!doctype html><html><body><h1 id="h">Hello</h1></body></html>' },
    assets:[], createdAt:1, updatedAt:1 };
  const { page: p2, ctx: c2 } = await newPage(seed({ apps:[app] }), null);
  await p2.goto(`${ORIGIN}/?app=local1`, { waitUntil:'networkidle' });
  await p2.waitForTimeout(900);
  ok('an installed app opens with no account', await p2.isVisible('#player'));
  ok('no sign-in was demanded', !(await p2.isVisible('#auth-screen')));
  await c2.close();
}

/* ------------------------------------------------------------- 7. market */

group('Market: review, publish, daily limit');
let publishedId = null;
{
  const { page, ctx, errs } = await newPage(seed());
  await buildApp(page);

  await page.click('.artifact .btn.dark');                 // "Marketga joylash"
  await page.waitForTimeout(300);
  ok('the publish sheet opened', (await page.textContent('#sheet-body h3')).includes('Publish'));

  await page.click('#sheet-body .btn.primary');            // start the AI review
  await page.waitForSelector('.verdict', { timeout: 30000 });
  ok('the AI review passed', await page.isVisible('.verdict.ok'));
  ok('a category was assigned', (await page.textContent('.verdict')).includes('Tools'));

  await page.click('#sheet-body .btn.primary');            // submit
  await page.waitForSelector('.note.ok', { timeout: 20000 });
  ok('it reached the server', (await page.textContent('.note.ok')).includes('market'));

  const cat = await marketApi('/api/market/index.json');
  publishedId = cat.apps[0]?.id;
  ok('it appears in the catalogue', cat.apps.length === 1 && cat.apps[0].name === 'Calculator',
     JSON.stringify(cat.apps.map(a => a.name)));
  ok('the category was created', cat.categories[0]?.id === 'tools', JSON.stringify(cat.categories));
  ok('the author was recorded', cat.apps[0]?.author === 'Tester');

  // second publish, same device, same day
  await page.click('#sheet-body .btn.primary');            // closes the sheet
  await page.waitForTimeout(300);
  await page.click('.artifact .btn.dark');
  await page.waitForTimeout(400);
  ok('the daily limit holds', (await page.textContent('#sheet-body')).includes('One app a day'));
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Market: someone else installs it');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.click('#tab-market');
  await page.waitForSelector('.mk-card', { timeout: 20000 });
  ok('it is listed', (await page.textContent('.mk-card b')) === 'Calculator');
  ok('the card shows an install count', await page.isVisible('.mk-installs'));

  await page.click('.mk-card .mk-get');                    // GET
  await page.waitForTimeout(1500);
  const apps = await page.evaluate(() => JSON.parse(localStorage['mini.v1']).apps);
  ok('the app was installed', apps.length === 1 && apps[0].marketId === publishedId,
     JSON.stringify(apps.map(a => a.marketId)));
  ok('its files came with it', !!apps[0]?.files?.['index.html']);
  ok('add-to-home was offered', await page.isVisible('#sheet-wrap'));

  await page.waitForTimeout(3400);            // counts are coalesced server-side
  const cat = await marketApi('/api/market/index.json');
  ok('the install count went up', cat.apps[0].installs >= 1, String(cat.apps[0].installs));
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Market: the detail sheet runs the app before you take it');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.click('#tab-market');
  await page.waitForSelector('.mk-card', { timeout: 20000 });
  await page.click('.mk-card b');
  await page.waitForSelector('.mk-preview', { timeout: 15000 });
  await page.waitForTimeout(1600);

  ok('a live preview is mounted', await page.locator('.mk-stage iframe').isVisible());
  const pv = page.frameLocator('.mk-stage iframe');
  ok('the preview really runs', (await pv.locator('#out').textContent()) === '0',
     await pv.locator('#out').textContent());
  await pv.locator('button', { hasText:'7' }).click();
  await page.waitForTimeout(250);
  ok('you can try it before installing', (await pv.locator('#out').textContent()) === '7');
  ok('the author is shown', (await page.textContent('#sheet-body')).includes('Tester'));
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Market: an author ships a fix, installed copies catch up');
{
  const author = await makeAccount('Updater', 'updater');
  const publish = (body) => fetch(ORIGIN + '/api/market/submit', {
    method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + author.token },
    body: JSON.stringify(body) }).then(async r => ({ status:r.status, body: await r.json() }));

  const make = (n) => ({
    name:'Notepad', emoji:'📝', color:'#3B82F6', type:'app',
    review:{ ok:true, category:'tools', categoryName:'Tools', summary:'Jot things down.' },
    files:{ 'index.html':'<!doctype html><html><body><h1 id="v">version ' + n + '</h1>' +
      '<!--' + 'x'.repeat(300) + '--></body></html>' },
  });

  const v1 = await publish(make(1));
  ok('the first version is published', v1.status === 200, JSON.stringify(v1));

  const { page, ctx, errs } = await newPage(seed());
  await page.click('#tab-market');
  await page.waitForSelector('.mk-card', { timeout: 20000 });
  await page.locator('.mk-card', { hasText:'Notepad' }).locator('.mk-get').click();
  await page.waitForTimeout(1500);
  if (await page.isVisible('#sheet-wrap')) {
    await page.click('#sheet-scrim', { position:{ x:195, y:10 } });
    await page.waitForTimeout(300);
  }
  const installed = await page.evaluate(() =>
    JSON.parse(localStorage['mini.v1']).apps.find(a => a.name === 'Notepad'));
  ok('it installs with its line and version', installed?.marketLine && installed.marketVersion === 1,
     JSON.stringify({ line: installed?.marketLine, v: installed?.marketVersion }));
  ok('version 1 is what landed', installed.files['index.html'].includes('version 1'));

  // The author ships a fix the same day — an update must not cost the daily slot.
  const v2 = await publish(make(2));
  ok('an update does not need a fresh daily slot', v2.status === 200, JSON.stringify(v2));
  const cat = await marketApi('/api/market/index.json');
  const row = cat.apps.find(a => a.name === 'Notepad');
  ok('only the newest version is listed',
     cat.apps.filter(a => a.name === 'Notepad').length === 1 && row.version === 2,
     JSON.stringify(cat.apps.map(a => `${a.name} v${a.version}`)));
  ok('the install count carries over', row.installs >= 1, String(row.installs));

  await page.click('#btn-apps');
  await page.waitForTimeout(2500);
  ok('the tile is marked', await page.locator('.app-tile.has-update').first().isVisible());

  await page.locator('.app-tile.has-update').first().dispatchEvent('contextmenu');
  await page.waitForTimeout(400);
  ok('the menu offers the update',
     (await page.textContent('#sheet-body')).includes('Update available'));
  await page.click('#sheet-body .list-item >> nth=0');
  await page.waitForTimeout(2500);

  const after = await page.evaluate(() =>
    JSON.parse(localStorage['mini.v1']).apps.find(a => a.name === 'Notepad'));
  ok('the installed copy is now version 2', after.marketVersion === 2 &&
     after.files['index.html'].includes('version 2'),
     `v${after.marketVersion}`);
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

group('Market: shared links and server validation');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.goto(`${ORIGIN}/?m=${publishedId}`, { waitUntil:'networkidle' });
  await page.waitForSelector('#sheet-body .stat-row', { timeout: 20000 });
  ok('the link opened the app page', (await page.textContent('#sheet-body h3')) === 'Calculator');
  ok('it switched to the market', await page.isVisible('#view-market'));
  ok('the address was cleaned up', !page.url().includes('?m='));
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  const post = (body, token) => fetch(ORIGIN + '/api/market/submit', {
    method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token },
    body: JSON.stringify(body) }).then(async r => ({ status:r.status, body: await r.json() }));

  const anon = await fetch(ORIGIN + '/api/market/submit', { method:'POST',
    headers:{ 'Content-Type':'application/json' }, body:'{}' });
  ok('publishing without an account is refused', anon.status === 401, String(anon.status));

  const good = { name:'Tashqi', emoji:'🧪', color:'#E8171F', review:{ ok:true, category:'test' },
    files:{ 'index.html':'<!doctype html><html><body>' + 'x'.repeat(300) +
      '<script src="https://cdn.example.com/a.js"><\/script></body></html>' } };
  const r1 = await post(good, (await makeAccount('Val A', 'valid_a')).token);
  ok('an external script is refused', r1.status === 400 && /self-contained/.test(r1.body.error), JSON.stringify(r1));

  const r2 = await post({ ...good, files:{ 'index.html':'<html><body>hi</body></html>' } },
    (await makeAccount('Val B', 'valid_b')).token);
  ok('an empty app is refused', r2.status === 400, JSON.stringify(r2));

  const r3 = await post({ ...good, review:{ ok:false },
    files:{ 'index.html':'<!doctype html><html><body>' + 'y'.repeat(300) + '</body></html>' } },
    (await makeAccount('Val C', 'valid_c')).token);
  ok('an unreviewed app is refused', r3.status === 400 && /review/.test(r3.body.error), JSON.stringify(r3));
}

/* --------------------------------------------------- 9. handing over code */

group('Export: a real zip anyone can open');
{
  const { page, ctx, errs } = await newPage(seed());
  const b64 = await page.evaluate(async () => {
    const { projectZip } = await import('./js/zip.js');
    const app = { id:'demo', name:'Habit Tracker', emoji:'✅', color:'#31C56B',
      files:{ 'index.html':'<!doctype html><html><body><h1>Habits</h1></body></html>',
              'app.js':'console.log("hello");\n'.repeat(40) },
      assets:[{ name:'logo.png', data:'data:image/png;base64,iVBORw0KGgo=' }] };
    const blob = await projectZip(app, { url:'https://example.com/a/demo/' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const x of buf) bin += String.fromCharCode(x);
    return btoa(bin);
  });

  const zip = Buffer.from(b64, 'base64');
  ok('it is a zip', zip.subarray(0, 4).toString('hex') === '504b0304', zip.subarray(0, 4).toString('hex'));

  // Read it back the way any unzip tool would: central directory, then inflate.
  const zlib = await import('node:zlib');
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  ok('the directory is where it should be', eocd > 0, String(eocd));

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = {}, sizes = {};
  for (let k = 0; k < count; k++) {
    const method = view.getUint16(cursor + 10, true);
    const csize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const off = view.getUint32(cursor + 42, true);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString();
    const lv = new DataView(zip.buffer, zip.byteOffset + off, 30);
    const start = off + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    const body = zip.subarray(start, start + csize);
    entries[name] = method === 8 ? zlib.inflateRawSync(body) : body;
    sizes[name] = { stored: csize, raw: view.getUint32(cursor + 24, true), method };
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  ok('every file is in there',
     !!entries['index.html'] && !!entries['app.js'] && !!entries['README.md'] &&
     !!entries['.github/workflows/android.yml'] && !!entries['assets/logo.png'],
     Object.keys(entries).join(', '));
  ok('the contents survive the round trip',
     entries['index.html'].toString().includes('<h1>Habits</h1>'));
  ok('repetitive files are actually compressed',
     sizes['app.js'].method === 8 && sizes['app.js'].stored < sizes['app.js'].raw / 8,
     `${sizes['app.js'].raw} bytes stored as ${sizes['app.js'].stored}`);
  ok('the readme names the app', entries['README.md'].toString().includes('# Habit Tracker'));
  ok('the workflow points at the hosted address',
     entries['.github/workflows/android.yml'].toString().includes('https://example.com/a/demo/'));
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------ 9. parallel writers */

group('Parallel writers: the pool itself');
{
  const { page, ctx, errs } = await newPage(seed());
  const r = await page.evaluate(async (api) => {
    const { runWorkers, LESSON_SYSTEM } = await import('./js/subagent.js');
    const settings = { baseUrl: api, apiKey:'k', model:'mock/fast' };
    const jobs = [1, 2, 3, 4, 5].map(i =>
      ({ key:'k' + i, label:'L' + i, prompt:'THIS LESSON: Lesson ' + i + ' — number ' + i + ' of 5' }));

    let live = 0, peak = 0;
    const track = st => { if (st.running) { live++; peak = Math.max(peak, live); } else live--; };

    const t0 = Date.now();
    const two = await runWorkers(jobs, { settings, workers:2, system: LESSON_SYSTEM, onStep: track });
    const twoMs = Date.now() - t0;

    live = 0;
    let peak5 = 0;
    const track5 = st => { if (st.running) { live++; peak5 = Math.max(peak5, live); } else live--; };
    const t1 = Date.now();
    const five = await runWorkers(jobs, { settings, workers:5, system: LESSON_SYSTEM, onStep: track5 });
    const fiveMs = Date.now() - t1;

    // A system the mock does not answer with prose: every job should fail,
    // and the pool should still finish and report each one.
    const bad = await runWorkers(jobs.slice(0, 3), { settings, workers:3, system:'nothing to do' });

    const bodies = [...two.values()].map(v => v.body || '');
    return {
      peak, peak5, twoMs, fiveMs,
      okTwo: [...two.values()].filter(v => v.ok).length,
      okFive: [...five.values()].filter(v => v.ok).length,
      badOk: [...bad.values()].filter(v => v.ok).length,
      badCount: bad.size,
      badError: [...bad.values()][0]?.error || '',
      sample: bodies[0].slice(0, 20),
      keys: [...two.keys()].join(','),
    };
  }, API);

  ok('every job comes back', r.okTwo === 5 && r.keys === 'k1,k2,k3,k4,k5', JSON.stringify(r.keys));
  ok('the pool width is respected', r.peak === 2, String(r.peak));
  ok('a wider pool runs more at once', r.peak5 === 5, String(r.peak5));
  ok('and finishes sooner', r.fiveMs < r.twoMs, `${r.fiveMs}ms vs ${r.twoMs}ms`);
  ok('bodies arrive as HTML', r.sample.startsWith('<p>'), r.sample);
  ok('a failing batch still returns every job', r.badCount === 3 && r.badOk === 0, JSON.stringify(r));
  ok('and says why', /empty/.test(r.badError), r.badError);
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------ 11. the free model */

group('Free model: the operator pays, the server holds the key');
{
  const admin = (body) => fetch(ORIGIN + '/api/admin/config', {
    method:'POST', headers:{ 'Content-Type':'application/json', 'X-Admin-Token':'test-admin' },
    body: JSON.stringify(body) }).then(r => r.json());

  const before = await fetch(ORIGIN + '/api/config').then(r => r.json());
  ok('nothing is offered until an operator sets it', before.free === null, JSON.stringify(before));

  const set = await admin({ baseUrl: API, key:'server-side-secret', model:'mock/fast',
                            label:'House model', perDay: 5 });
  ok('the admin can configure one', set.free?.model === 'mock/fast', JSON.stringify(set));
  ok('the key is never handed back', !JSON.stringify(set).includes('server-side-secret'));

  const acct = await makeAccount('Freeloader', 'freeuser');
  // A brand new person with no API key of their own.
  const state = seed();
  delete state.settings.apiKey;
  delete state.settings.model;
  const { page, ctx, errs } = await newPage(state, acct);
  await page.waitForTimeout(700);

  const chosen = await page.evaluate(() => JSON.parse(localStorage['mini.v1']).settings.useFree);
  ok('a keyless account is switched onto it', chosen === true, String(chosen));
  ok('the composer is usable', await page.isVisible('#composer'));

  await buildApp(page);
  ok('it can build with no key at all', await page.isVisible('.artifact'));

  const me = await fetch(ORIGIN + '/api/auth/me', {
    headers:{ Authorization:'Bearer ' + acct.token } }).then(r => r.json());
  ok('usage is counted against the account', me.free.used >= 1, JSON.stringify(me.free));
  ok('a daily cap is reported', me.free.perDay === 5, JSON.stringify(me.free));

  await page.click('#btn-menu'); await page.waitForTimeout(250);
  await page.click('#btn-settings'); await page.waitForTimeout(400);
  const sheet = await page.textContent('#sheet-body');
  ok('the settings sheet names the model', sheet.includes('House model'), sheet.slice(0, 120));
  ok('and says what is left today', /of 5 messages left today/.test(sheet), sheet.slice(0, 200));
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  // Spend the rest of the allowance and check the wall.
  for (let i = 0; i < 6; i++) {
    await fetch(ORIGIN + '/api/ai/chat', {
      method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + acct.token },
      body: JSON.stringify({ messages:[{ role:'user', content:'hi' }] }) }).then(r => r.text());
  }
  const over = await fetch(ORIGIN + '/api/ai/chat', {
    method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + acct.token },
    body: JSON.stringify({ messages:[{ role:'user', content:'hi' }] }) });
  ok('the cap is enforced', over.status === 429, String(over.status));

  const anon = await fetch(ORIGIN + '/api/ai/chat', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ messages:[{ role:'user', content:'hi' }] }) });
  ok('it is not open to strangers', anon.status === 401, String(anon.status));

  await admin({ clear: true });
  const after = await fetch(ORIGIN + '/api/config').then(r => r.json());
  ok('the operator can turn it off again', after.free === null, JSON.stringify(after));
}

group('Admin panel: the screen, not the cheat sheet');
{
  const acct = await makeAccount('Owner', 'owner');
  const { page, ctx, errs } = await newPage(seed(), acct);

  // No admin rights yet: the settings sheet must not offer the panel.
  await page.click('#btn-menu'); await page.waitForTimeout(250);
  await page.click('#btn-settings'); await page.waitForTimeout(400);
  ok('an ordinary account sees no panel',
     !(await page.textContent('#sheet-body')).includes('Admin panel'));
  await page.click('#sheet-scrim', { position:{ x:195, y:10 } });
  await page.waitForTimeout(300);

  // The token is the way in before MINI_ADMIN_USERS is set.
  await page.goto(`${ORIGIN}/?admin=1`, { waitUntil:'networkidle' });
  await page.waitForTimeout(1000);
  ok('?admin=1 asks for the token',
     (await page.textContent('#sheet-body')).includes('Admin token'));
  await page.fill('#sheet-body input[type=password]', 'test-admin');
  await page.click('#sheet-body .btn.primary');
  await page.waitForTimeout(900);

  const panel = await page.textContent('#sheet-body');
  ok('the panel opens', panel.includes('accounts') && panel.includes('installs'), panel.slice(0, 90));
  ok('it reports the market', panel.includes('All apps'));
  ok('and offers the free model', panel.includes('Set one up') || panel.includes('Change it'));

  await page.locator('#sheet-body .list-item', { hasText:'Set one up' }).click();
  await page.waitForTimeout(400);
  const inputs = page.locator('#sheet-body input');
  await inputs.nth(0).fill(API);
  await inputs.nth(1).fill('secret-from-the-panel');
  await inputs.nth(2).fill('mock/fast');
  await inputs.nth(3).fill('House model');
  await inputs.nth(4).fill('7');
  await page.click('#sheet-body .btn.primary');
  await page.waitForTimeout(700);

  const cfg = await fetch(ORIGIN + '/api/config').then(r => r.json());
  ok('the free model was set from the panel',
     cfg.free?.model === 'mock/fast' && cfg.free.perDay === 7, JSON.stringify(cfg));
  ok('the key stays on the server', !JSON.stringify(cfg).includes('secret-from-the-panel'));

  // The token is remembered, so the panel is one tap away next time.
  await page.goto(`${ORIGIN}/`, { waitUntil:'networkidle' });
  await page.waitForTimeout(900);
  await page.click('#btn-menu'); await page.waitForTimeout(250);
  await page.click('#btn-settings'); await page.waitForTimeout(500);
  ok('and it is remembered', (await page.textContent('#sheet-body')).includes('Admin panel'));

  await fetch(ORIGIN + '/api/admin/config', { method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-Admin-Token':'test-admin' },
    body: JSON.stringify({ clear:true }) });
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* --------------------------------------------- 12. the inactivity rule */

group('The inactivity rule');
{
  const { Auth } = await import(path.join(ROOT, 'server/auth.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-auth-'));
  const a = new Auth(dir, { inactiveDays: 30 });

  a.register({ name:'Active', username:'active', password:'olmaqogoz7' });
  a.register({ name:'Idle', username:'idle', password:'olmaqogoz7' });
  const stale = a.users.find(u => u.username === 'idle');
  stale.lastSeen = Date.now() - 31 * 86_400_000;

  ok('after 30 silent days nothing is left', a.daysLeft(stale) === 0, String(a.daysLeft(stale)));
  const removed = a.sweep();
  ok('the idle account was removed', removed.length === 1 && a.users.length === 1, JSON.stringify(removed));
  ok('the active one stayed', a.users[0].username === 'active');
  ok('the freed username is available again', !a.byName.has('idle'));

  // the file on disk agrees with memory
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  ok('the file on disk agrees', onDisk.length === 1 && onDisk[0].username === 'active');

  // tokens survive a restart, forged ones never work
  const token = a.issue(a.users[0]);
  const b = new Auth(dir, { inactiveDays: 30 });
  ok('a token survives a restart', b.verify(token)?.username === 'active');
  ok('a forged token does not', b.verify(token.slice(0, -1) + 'x') === null);
  ok('passwords are checked',
     !!b.login({ username:'active', password:'olmaqogoz7', ip:'1.1.1.1' }).user &&
     !!b.login({ username:'active', password:'wrongone', ip:'2.2.2.2' }).error);

  // changing the password must not leave the old session usable
  const old = b.issue(b.users[0]);
  b.changePassword(b.users[0], { current:'olmaqogoz7', next:'newpass99' });
  ok('changing the password kills old sessions', b.verify(old) === null);
  ok('the new password works', !!b.login({ username:'active', password:'newpass99', ip:'3.3.3.3' }).user);

  // sign-ups are capped per address, and the cap is per address
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-auth2-'));
  process.env.MINI_REGS_PER_HOUR = '3';
  const { Auth: Auth2 } = await import(path.join(ROOT, 'server/auth.js') + '?cap');
  const c = new Auth2(dir2, {});
  const tries = [1, 2, 3, 4].map(i =>
    c.register({ name:'New', username:'new' + i, password:'olmaqogoz7', ip:'9.9.9.9' }));
  ok('sign-ups are capped per hour', !!tries[3].error && !tries[2].error,
     JSON.stringify(tries.map(t => t.error || 'ok')));
  ok('another address is unaffected',
     !c.register({ name:'New', username:'other1', password:'olmaqogoz7', ip:'8.8.8.8' }).error);
  fs.rmSync(dir2, { recursive:true, force:true });
  fs.rmSync(dir, { recursive:true, force:true });
}

/* ----------------------------------------------------------- 10. course */

group('Course: outline, lessons, player');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.click('#btn-role'); await page.waitForTimeout(300);
  await page.click('#sheet-body .list-item >> nth=1');       // Course builder
  await page.waitForTimeout(300);
  ok('the course role is selected', (await page.textContent('#role-name')) === 'Course builder');

  await page.fill('#input', 'I want an IELTS course');
  await page.click('#btn-send');
  await page.waitForSelector('.artifact', { timeout: 60000 });
  await page.waitForTimeout(600);

  const steps = await page.locator('.msg.ai .step b').allTextContents();
  ok('an outline came first', steps[0]?.startsWith('Outline'), steps.join(' | '));
  ok('the batch reports what it wrote', steps.some(x => x === 'Wrote 3 of 3 lessons'), steps.join(' | '));
  ok('each writer has its own row',
     steps.filter(x => /^Lesson \d\/3:/.test(x)).length === 3, steps.join(' | '));
  ok('the card counts lessons',
     (await page.textContent('.artifact-meta span')).includes('3 lessons'),
     await page.textContent('.artifact-meta span'));

  const st = await page.evaluate(() => JSON.parse(localStorage['mini.v1']));
  const files = Object.keys(st.chats[0].project.files);
  ok('lesson files are kept separately', files.filter(f => f.startsWith('lessons/')).length === 3, files.join());
  ok('the player was generated', files.includes('index.html'));
  const oneLesson = st.chats[0].project.files['lessons/intro.html'];
  ok('the markdown fence is stripped off', !!oneLesson && !oneLesson.includes('```'),
     (oneLesson || '').slice(0, 40));

  // open it and walk through a lesson
  await page.click('.artifact-actions .btn');
  await page.waitForTimeout(900);
  const f = page.frameLocator('#player-stage iframe');
  ok('the cover shows the title', (await f.locator('.hero h1').textContent()) === 'IELTS Band 7');
  ok('progress starts at zero', (await f.locator('#hpc').textContent()).includes('0 of 3'));

  await f.locator('#continue').click();
  await page.waitForTimeout(400);
  ok('a lesson opens', (await f.locator('#body h1').textContent()).includes('What the test looks like'));

  await f.locator('#body .q li').nth(0).click();             // wrong answer
  await page.waitForTimeout(200);
  ok('a wrong answer is marked', await f.locator('#body .q li.wrong').isVisible());
  ok('the right answer is revealed', await f.locator('#body .q li.right').isVisible());
  ok('the explanation appears', await f.locator('#body .q .why').isVisible());

  await f.locator('#body .fill input').fill('once');
  await page.waitForTimeout(200);
  ok('a filled blank is graded', await f.locator('#body .fill input.right').isVisible());

  await f.locator('#next').click();
  await page.waitForTimeout(400);
  await f.locator('#back').click();
  await page.waitForTimeout(400);
  ok('progress was saved', (await f.locator('#hpc').textContent()).includes('1 of 3'),
     await f.locator('#hpc').textContent());
  ok('the lesson is ticked off', await f.locator('#home .tick.on').first().isVisible());
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------- 11. book */

group('Book: chapters, cover, reader');
{
  const { page, ctx, errs } = await newPage(seed());
  await page.click('#btn-role'); await page.waitForTimeout(300);
  await page.click('#sheet-body .list-item >> nth=2');       // Book writer
  await page.waitForTimeout(300);

  await page.fill('#input', 'write a book about coffee');
  await page.click('#btn-send');
  await page.waitForSelector('.artifact', { timeout: 60000 });
  await page.waitForTimeout(600);

  const steps = await page.locator('.msg.ai .step b').allTextContents();
  ok('chapters were written', steps.filter(x => x.startsWith('Chapter')).length === 2, steps.join(' | '));
  ok('a cover was set', steps.some(x => x.startsWith('Cover')), steps.join(' | '));

  const st = await page.evaluate(() => JSON.parse(localStorage['mini.v1']));
  ok('the cover is a file', !!st.chats[0].project.files['cover.svg']);

  await page.click('.artifact-actions .btn');
  await page.waitForTimeout(900);
  const f = page.frameLocator('#player-stage iframe');
  ok('the cover art renders', await f.locator('#home .cover-art svg').isVisible());
  ok('the author is shown', (await f.locator('#home .cover .by').textContent()) === 'Mini');
  ok('contents are listed', (await f.locator('#home .ch-link').count()) === 2);

  await f.locator('#home .ch-link').first().click();
  await page.waitForTimeout(400);
  ok('a chapter opens', (await f.locator('#body h1').textContent()).includes('Where coffee comes from'));
  ok('the chapter is numbered', (await f.locator('#body h1 span').textContent()) === 'Chapter 1');

  const before = await f.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--fs'));
  await f.locator('#bigger').click();
  await page.waitForTimeout(200);
  const after = await f.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--fs'));
  ok('the type size control works', before !== after, `${before} -> ${after}`);
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* -------------------------------------------------- 12. reading documents */

group('Documents: PDF, EPUB and plain text');
{
  const zlib = await import('node:zlib');

  // A small but genuine PDF: a Flate-compressed content stream with one string.
  const content = Buffer.from('BT /F1 12 Tf 72 720 Td (The quick brown fox jumps over the lazy dog.) Tj ET\n' +
                              'BT /F1 12 Tf 72 700 Td (Second line of the document.) Tj ET');
  const zipped = zlib.deflateSync(content);
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
                '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
                '3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n' +
                `4 0 obj<</Length ${zipped.length}/Filter/FlateDecode>>stream\n`),
    zipped,
    Buffer.from('\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF'),
  ]);

  // A small but genuine EPUB: a real zip with a manifest and one chapter.
  const crc = (buf) => {
    if (zlib.crc32) return zlib.crc32(buf) >>> 0;
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const entries = [
    ['mimetype', Buffer.from('application/epub+zip'), 0],
    ['content.opf', Buffer.from('<package><manifest><item id="c1" href="ch1.xhtml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>'), 8],
    ['ch1.xhtml', Buffer.from('<html><body><h1>Chapter One</h1>' +
      '<p>The bean travelled a long way before anyone thought to roast it. ' +
      'It crossed a sea, changed hands four times, and arrived with a name nobody could pronounce.</p>' +
      '</body></html>'), 8],
  ];
  const locals = [], central = [];
  let off = 0;
  for (const [name, body, method] of entries) {
    const data = method === 8 ? zlib.deflateRawSync(body) : body;
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc(body), 14); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc(body), 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  const epub = Buffer.concat([localBuf, centralBuf, eocd]);

  const { page, ctx, errs } = await newPage(seed());
  const out = await page.evaluate(async ({ pdfB64, epubB64 }) => {
    const { extractText, ExtractError } = await import('./extract.js'.replace('./', './js/'));
    const asFile = (b64, name, type) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type });
    };
    const res = {};
    res.txt = await extractText(new File([new Blob(['Plain text, straight through. '.repeat(4)])],
      'notes.txt', { type:'text/plain' }));
    res.html = await extractText(new File([new Blob(
      ['<html><body><h1>Title</h1><p>Body text that survives the tags.</p></body></html>'.repeat(2)])],
      'page.html', { type:'text/html' }));
    res.pdf = await extractText(asFile(pdfB64, 'book.pdf', 'application/pdf'));
    res.epub = await extractText(asFile(epubB64, 'book.epub', 'application/epub+zip'));
    try { await extractText(new File([new Blob(['x'])], 'thing.zip')); res.bad = 'no error'; }
    catch (e) { res.bad = e instanceof ExtractError ? e.message : 'wrong error'; }
    return res;
  }, { pdfB64: pdf.toString('base64'), epubB64: epub.toString('base64') });

  ok('plain text is read', out.txt.text.includes('Plain text, straight through'));
  ok('HTML tags are stripped', out.html.text.includes('Body text that survives') &&
     !out.html.text.includes('<p>'), out.html.text.slice(0, 60));
  ok('PDF text is extracted', out.pdf.text.includes('quick brown fox'), out.pdf.text.slice(0, 80));
  ok('every PDF line is found', out.pdf.text.includes('Second line'), out.pdf.text.slice(0, 120));
  ok('EPUB chapters are read', out.epub.text.includes('travelled a long way'), out.epub.text.slice(0, 90));
  ok('EPUB markup is stripped', !out.epub.text.includes('<h1>'));
  ok('the title comes from the filename', out.pdf.title === 'book');
  ok('an unknown type is refused', out.bad === 'unsupported', out.bad);
  ok('no console errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------- results */

await browser.close();
await done();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
