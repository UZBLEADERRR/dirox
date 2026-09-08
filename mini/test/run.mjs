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
  ok('start_url points at the app', r.body.start_url.includes('?app=demo'), r.body.start_url);
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
  await page.waitForSelector('.mk-row', { timeout: 20000 });
  ok('it is listed', (await page.textContent('.mk-row b')) === 'Calculator');

  await page.click('.mk-row .mk-get');                     // OLISH
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

/* --------------------------------------------- 9. the inactivity rule */

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
  ok('three lessons were written', steps.filter(x => x.startsWith('Lesson')).length === 3, steps.join(' | '));
  ok('the card counts lessons',
     (await page.textContent('.artifact-meta span')).includes('3 lessons'),
     await page.textContent('.artifact-meta span'));

  const st = await page.evaluate(() => JSON.parse(localStorage['mini.v1']));
  const files = Object.keys(st.chats[0].project.files);
  ok('lesson files are kept separately', files.filter(f => f.startsWith('lessons/')).length === 3, files.join());
  ok('the player was generated', files.includes('index.html'));

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
