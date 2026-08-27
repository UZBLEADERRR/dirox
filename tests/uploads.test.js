/**
 * Files coming in.
 *
 * The interesting part is the type check. An avatar URL ends up inside an
 * `<img>`, and a file that claims to be a PNG while actually being markup is
 * a stored cross-site script waiting for somewhere that renders it. So the
 * bytes decide, never the header.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniff, MAX_UPLOAD_BYTES, MAX_AVATAR_BYTES } from '../src/modules/uploads/routes.js';
import { safeName } from '../src/agent/tools/deliver.js';

/** Real magic bytes, not a description of them. */
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('474946383961', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

test('an image is recognised by its bytes', () => {
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(JPEG), 'image/jpeg');
  assert.equal(sniff(GIF), 'image/gif');
  assert.equal(sniff(WEBP), 'image/webp');
});

test('markup wearing an image name is not an image', () => {
  // This is the whole point. A `Content-Type: image/png` header costs nothing
  // to write, and an avatar is rendered wherever the profile appears.
  const html = Buffer.from('<script>fetch("/api/me")</script>');
  const svgWithScript = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  assert.equal(sniff(html), null);
  assert.equal(sniff(svgWithScript), null, 'SVG is markup and is not accepted as an avatar');
});

test('a truncated header is not a match', () => {
  assert.equal(sniff(Buffer.from('89504e', 'hex')), null, 'three of four PNG bytes is not a PNG');
  assert.equal(sniff(Buffer.alloc(0)), null);
  assert.equal(sniff(Buffer.from('RIFF')), null, 'RIFF alone is not WebP');
});

test('an upload name cannot become a path or a header', () => {
  // The name becomes a storage key segment and, once placed, a file in a
  // repository.
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('logo.png'), 'logo.png');
  assert.equal(safeName('my logo (final).png'), 'my logo (final).png');
  assert.equal(safeName('a\r\nX-Injected: 1.png'), 'aX-Injected- 1.png');
});

test('the limits are the ones the interface promises', () => {
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  assert.equal(MAX_AVATAR_BYTES, 4 * 1024 * 1024);
});
