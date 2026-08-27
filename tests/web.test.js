/**
 * Reading the web without letting the web read us.
 *
 * `web_fetch` is the most dangerous tool in the product and does not look like
 * one: it takes an address chosen by a model — possibly copied out of a page
 * the model fetched a moment earlier — and makes our server go there. Our
 * container can reach the cloud metadata endpoint, our own API and whatever
 * else the deployment runs.
 *
 * So most of what is tested here is refusal, and the cases are the specific
 * ways a name-based blocklist gets walked past.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateAddress, assertPublicUrl } from '../src/net/safefetch.js';
import { readable, decodeEntities, pageTitle } from '../src/net/readable.js';
import { parseDuckDuckGo } from '../src/net/search.js';

// ─── what must never be fetched ─────────────────────────────────────────────

test('the addresses that hand out credentials are private', () => {
  // 169.254.169.254 is the cloud metadata endpoint. On most providers it will
  // hand instance credentials to anything inside the network that asks, which
  // makes it the single most valuable address an SSRF can reach.
  assert.equal(isPrivateAddress('169.254.169.254'), true);

  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, `${address} was treated as public`);
  }
});

test('the same holes in IPv6 are the same holes', () => {
  for (const address of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, `${address} was treated as public`);
  }
});

test('a public address is public', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '140.82.121.4', '2606:4700::1111', '172.32.0.1', '192.169.0.1']) {
    assert.equal(isPrivateAddress(address), false, `${address} was treated as private`);
  }
});

test('a hostname that resolves to loopback is refused, whatever it is called', async () => {
  // `localhost` is the obvious one. A name that resolves to 127.0.0.1 is how
  // a blocklist of names rather than addresses gets walked past.
  await assert.rejects(() => assertPublicUrl('http://localhost:3000/api/admin'), /private address/i);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/'), /private address/i);
  await assert.rejects(() => assertPublicUrl('http://[::1]:8080/'), /private address/i);
});

test('only http and https are fetched', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/x', 'data:text/html,hi']) {
    await assert.rejects(() => assertPublicUrl(url), /only http and https/i, `${url} was allowed`);
  }
});

test('credentials in a URL are not used on the user\'s behalf', async () => {
  await assert.rejects(() => assertPublicUrl('https://admin:hunter2@example.com/'), /username or password/i);
});

test('nonsense is refused as nonsense', async () => {
  await assert.rejects(() => assertPublicUrl('not a url'), /is not a URL/i);
  await assert.rejects(() => assertPublicUrl(''), /is not a URL/i);
});

// ─── turning a page into something worth paying for ─────────────────────────

const PAGE = `<!doctype html>
<html><head>
  <title>Rate limiting in Express</title>
  <meta name="description" content="How to limit requests per IP.">
  <style>.nav{color:red}</style>
  <script>window.analytics = {track(){}}</script>
</head>
<body>
  <nav><a href="/">Home</a><a href="/docs">Docs</a><a href="/blog">Blog</a></nav>
  <article>
    <h1>Rate limiting in Express</h1>
    <p>Use a sliding window, not a fixed one &mdash; a fixed window lets twice the limit through at the boundary.</p>
    <h2>Storage</h2>
    <ul><li>In memory, for one process</li><li>Redis, for more than one</li></ul>
    <p>See the <a href="https://example.com/spec">specification</a> for the headers.</p>
  </article>
  <footer><p>&copy; 2026 Example Inc. All rights reserved. Privacy. Terms. Cookies.</p></footer>
  <script>console.log('tracking')</script>
</body></html>`;

test('a page comes back as what a person would have read', () => {
  const page = readable(PAGE);

  assert.equal(page.title, 'Rate limiting in Express');
  assert.equal(page.description, 'How to limit requests per IP.');

  // The content survives, with its structure legible.
  assert.match(page.text, /# Rate limiting in Express/);
  assert.match(page.text, /## Storage/);
  assert.match(page.text, /- In memory, for one process/);
  assert.match(page.text, /sliding window, not a fixed one — a fixed window/);

  // A link's address is often the point, so it is kept beside its text.
  assert.match(page.text, /specification \(https:\/\/example\.com\/spec\)/);
});

test('script, style and chrome do not reach the model', () => {
  const page = readable(PAGE);
  assert.ok(!page.text.includes('window.analytics'), 'a script body was sent to the model');
  assert.ok(!page.text.includes('color:red'), 'a stylesheet was sent to the model');
  assert.ok(!page.text.includes('All rights reserved'), 'the footer was sent to the model');
});

test('the reduction is worth doing', () => {
  const page = readable(PAGE);
  assert.ok(page.text.length < PAGE.length / 2,
    `the page went from ${PAGE.length} to ${page.text.length} characters, which is not a reduction`);
});

test('a page whose whole content is inside chrome is not emptied', () => {
  /*
     Stripping <form> and <nav> unconditionally is how a documentation search
     page, or a wiki edit view, comes back blank. Chrome is only removed when
     there is a plausible page left without it.
  */
  const body = `Everything on this page lives inside a form element. ${'It is a real page with real content. '.repeat(12)}`;
  const page = readable(`<html><body><form><h1>Search</h1><p>${body}</p></form></body></html>`);
  assert.match(page.text, /Everything on this page lives inside a form/);
});

test('entities become the characters they stand for', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;'), 'a & b <c> "d" A B');
  // An entity we do not know is left alone rather than eaten.
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('a title is found however the page states it', () => {
  assert.equal(pageTitle('<title>  Spaced   out  </title>'), 'Spaced out');
  assert.equal(pageTitle('<meta property="og:title" content="From og"><title>From title</title>'), 'From og');
  assert.equal(pageTitle('<html><body>nothing</body></html>'), null);
});

test('a long page is cut with the cut declared', () => {
  const page = readable(`<p>${'word '.repeat(6000)}</p>`, { maxChars: 500 });
  assert.equal(page.truncated, true);
  assert.match(page.text, /more characters/);
  assert.ok(page.text.length < 700);
});

// ─── free search, parsed narrowly ───────────────────────────────────────────

test('the free search endpoint is read, and its redirect wrapper unwrapped', () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexpressjs.com%2Fen%2Fguide.html&amp;rut=x">Express guide</a>
      <a class="result__snippet">The official guide to Express.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/two">Second &amp; last</a>
      <a class="result__snippet">Another one.</a>
    </div>`;

  const results = parseDuckDuckGo(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://expressjs.com/en/guide.html', 'the redirect wrapper was left in place');
  assert.equal(results[0].title, 'Express guide');
  assert.equal(results[0].snippet, 'The official guide to Express.');
  assert.equal(results[1].title, 'Second & last');
});

test('when the page changes shape the answer is nothing, not nonsense', () => {
  assert.deepEqual(parseDuckDuckGo('<html><body>rewritten in react</body></html>'), []);
  assert.deepEqual(parseDuckDuckGo(''), []);
});
