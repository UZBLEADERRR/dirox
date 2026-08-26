/**
 * Static serving, and the one thing it exists to prevent: a page assembled
 * from two different deploys.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { serveStatic, buildId } from '../src/static.js';

let base = '';
let server = null;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await serveStatic(req, res, url)) return;
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const get = path => fetch(`${base}${path}`);

test('the shell stamps its own assets and leaves everything else alone', async () => {
  const build = await buildId();
  const html = await (await get('/index.html')).text();

  assert.match(html, new RegExp(`href="/v/${build}/styles/tokens\\.css"`), 'stylesheets are stamped');
  assert.match(html, new RegExp(`src="/v/${build}/app/main\\.js"`), 'the entry module is stamped');
  assert.match(html, /href="\/site\.webmanifest"/, 'the manifest is not an app asset and stays as written');
  assert.ok(!html.includes(`/v/${build}/v/`), 'stamping must not compound');
});

test('a stamped URL serves the same file, cached for a year', async () => {
  const build = await buildId();
  const stamped = await get(`/v/${build}/app/main.js`);
  const bare = await get('/app/main.js');

  assert.equal(stamped.status, 200);
  assert.equal(await stamped.text(), await bare.text(), 'the prefix changes the URL, not the file');
  assert.match(stamped.headers.get('cache-control'), /immutable/);
  assert.match(stamped.headers.get('content-type'), /javascript/);
});

test('the shell is never cached, so a deploy shows up on the next navigation', async () => {
  const response = await get('/index.html');
  assert.match(response.headers.get('cache-control'), /no-cache/);
});

test('a page loading during a deploy is not torn in half', async () => {
  // A browser that already has the old shell keeps asking for the old prefix.
  // Those requests must still resolve, or the page breaks mid-load.
  const response = await get('/v/000000000000/app/main.js');
  assert.equal(response.status, 200);
});

test('a missing asset is a 404, not the app shell', async () => {
  const build = await buildId();
  for (const path of [`/v/${build}/app/nope.js`, '/app/nope.js']) {
    const response = await get(path);
    assert.equal(response.status, 404, `${path} returned ${response.status}`);
  }
});

test('a deep link still reaches the shell', async () => {
  const response = await get('/app/projects/some-id');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /html/);
});

test('the version prefix is not a way out of the web root', async () => {
  const build = await buildId();

  // `fetch` normalises a path before sending it, which is exactly what an
  // attacker would not do, so these go out over a raw request unchanged.
  const raw = path => new Promise((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port: server.address().port, path, method: 'GET' }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => done({ status: response.statusCode, body }));
    });
    request.on('error', fail);
    request.end();
  });

  for (const path of [
    `/v/${build}/../../../etc/passwd`,
    `/v/${build}/..%2f..%2f..%2fetc%2fpasswd`,
    '/../../etc/passwd',
    `/v/${build}/../src/config/env.js`,
    '/../src/config/env.js'
  ]) {
    const response = await raw(path);
    assert.ok(!response.body.includes('root:'), `${path} served /etc/passwd`);
    assert.ok(!response.body.includes('SUPABASE'), `${path} served a server module`);
  }
});

test('a deploy that only changed the server keeps the client cached', async () => {
  // The build is hashed from what the files contain, not when they were
  // written, so redeploying identical assets does not make every browser
  // download them again.
  const { utimes } = await import('node:fs/promises');
  const path = new URL('../web/styles/tokens.css', import.meta.url);
  const before = await buildId();

  const now = new Date();
  await utimes(path, now, now);

  const { buildId: freshBuildId } = await import(`../src/static.js?reload=${Date.now()}`);
  assert.equal(await freshBuildId(), before, 'a touched but unchanged file must not change the build');
});

test('an unchanged asset costs a 304 and no body', async () => {
  const first = await get('/app/main.js');
  const etag = first.headers.get('etag');
  assert.ok(etag);

  const second = await fetch(`${base}/app/main.js`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal((await second.text()).length, 0);
});
