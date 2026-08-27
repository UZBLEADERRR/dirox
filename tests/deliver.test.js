/**
 * Handing a file to the user.
 *
 * The feature is small; the refusals are the point. A tool that turns a
 * workspace path into a download link is an exfiltration primitive if it is
 * careless, and a filename that reaches an HTTP header, a save dialog and a
 * filesystem is three injection surfaces wearing one hat.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeName, contentTypeFor, humanSize, deliverTools } from '../src/agent/tools/deliver.js';
import { isSecretPath } from '../src/exec/workspace.js';
import { evaluateCommand } from '../src/exec/policy.js';

test('a credential file is never a deliverable', () => {
  // The tool refuses these before touching the filesystem, and the download
  // route refuses them again before serving a byte.
  for (const path of [
    '.env', '.env.production', 'config/.env.local',
    'id_rsa', 'server.key', 'cert.pem', 'service-account.json',
    '.npmrc', 'credentials.json'
  ]) {
    assert.equal(isSecretPath(path), true, `${path} must be treated as a credential file`);
  }
});

test('ordinary build output is deliverable', () => {
  for (const path of ['dist/app.zip', 'build/app-release.apk', 'report.pdf', 'out/bundle.tar.gz']) {
    assert.equal(isSecretPath(path), false, path);
  }
});

test('a filename cannot smuggle a header, a path or a shell', () => {
  assert.equal(safeName('dist/app.zip'), 'app.zip', 'the directory is not part of the name');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('a"b.zip'), 'a-b.zip', 'a quote would end the filename in the header');
  // The newline goes, and so does the colon: both are header syntax.
  assert.equal(safeName('a\nContent-Length: 0\r\n.zip'), 'aContent-Length- 0.zip',
    'a newline would start a second header');
  assert.equal(safeName('...'), 'download', 'a name of only dots is no name');
  assert.equal(safeName(''), 'download');
  assert.equal(safeName('x'.repeat(400)).length, 120, 'names are bounded');
});

test('the content type follows the extension, and defaults to a download', () => {
  assert.equal(contentTypeFor('app.apk'), 'application/vnd.android.package-archive');
  assert.equal(contentTypeFor('report.pdf'), 'application/pdf');
  assert.equal(contentTypeFor('bundle.ZIP'), 'application/zip', 'extensions are not case sensitive');
  assert.equal(contentTypeFor('mystery.qqq'), 'application/octet-stream');
  // Never text/html for an unknown file: a browser would render it as a page
  // on this origin.
  assert.notEqual(contentTypeFor('payload'), 'text/html');
});

test('sizes read the way a person would say them', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(900), '900 B');
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
});

test('delivering is a write, not an outward action', () => {
  // It creates something the user can act on, but publishes nothing outside
  // the account, so it must not add an approval prompt to every export.
  const deliver = deliverTools.find(tool => tool.name === 'deliver_file');
  assert.equal(deliver.risk, 'write');
});

test('the agent can build an archive, and still cannot reach the network', async () => {
  // "Send me the project as a zip" needs a way to make one; without these the
  // agent could only describe the idea.
  for (const command of ['zip -r out.zip src', 'tar -czf out.tgz .', 'unzip archive.zip']) {
    assert.equal((await evaluateCommand(command)).ok, true, command);
  }
  for (const command of ['curl https://example.com', 'wget https://example.com', 'ssh host']) {
    assert.equal((await evaluateCommand(command)).ok, false, command);
  }
});

test('an archive cannot be pointed outside the workspace', async () => {
  const result = await evaluateCommand('zip -r out.zip ../../etc');
  assert.equal(result.ok, false);
  assert.match(result.reason, /outside the project workspace/);
});
