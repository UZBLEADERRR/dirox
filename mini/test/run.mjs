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

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_PORT = 8899, API_PORT = 8900;
const BASE = `http://127.0.0.1:${WEB_PORT}/index.html`;
const API  = `http://127.0.0.1:${API_PORT}/v1`;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };

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

/* --------------------------------------------------------------- setup */

const web = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(WEB_PORT);

const api = spawn(process.execPath, [path.join(ROOT, 'test/mock-provider.mjs')],
  { stdio:'ignore', env:{ ...process.env, MOCK_PORT:String(API_PORT) } });

const done = () => { web.close(); api.kill(); };
await new Promise(r => setTimeout(r, 600));

let chromium, devices;
try { ({ chromium, devices } = await import('playwright')); }
catch { console.error('playwright topilmadi. `npm i -D playwright` yoki global o\'rnating.'); done(); process.exit(2); }

const browser = await chromium.launch();
const newPage = async (state) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.addInitScript(`try { localStorage.setItem('mini.v1', ${JSON.stringify(JSON.stringify(state))}); } catch (e) {}`);
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

/* ------------------------------------------------------------- results */

await browser.close();
done();
console.log(`\n${pass} ta o'tdi, ${fail} ta yiqildi.`);
process.exit(fail ? 1 : 0);
