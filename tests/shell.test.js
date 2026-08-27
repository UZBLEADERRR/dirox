/**
 * The command policy.
 *
 * This is the boundary between "the agent can build software" and "the agent
 * can do anything to this machine", so it is tested as a boundary: what must
 * be allowed, what must be refused, and the ways someone would try to make
 * the second look like the first.
 *
 * The design in one line: composition is allowed, substitution is not. Every
 * executable that will run has to be visible in the text, or the allowlist is
 * checking something other than what runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCommand } from '../src/exec/policy.js';
import { lex, segment, redirectAllowed, findSubstitution } from '../src/exec/shell.js';

const allow = async command => {
  const result = await evaluateCommand(command);
  assert.equal(result.ok, true, `${command} — refused: ${result.reason}`);
  return result;
};

const refuse = async (command, pattern) => {
  const result = await evaluateCommand(command);
  assert.equal(result.ok, false, `${command} — was allowed`);
  if (pattern) assert.match(result.reason, pattern, `${command} — wrong reason: ${result.reason}`);
  return result;
};

// ─── what real work looks like ──────────────────────────────────────────────

test('a build script runs', async () => {
  // Every one of these is ordinary. Refusing them does not make anything
  // safer; it makes the agent unable to build software.
  for (const command of [
    'npm run build && npm test',
    'npm ci; npm run build',
    'npm test 2>&1 | tail -40',
    'tsc --noEmit && eslint src',
    'zip -r out.zip src && ls -la out.zip',
    'ls missing 2>/dev/null || echo "not there"',
    'cat package.json | grep version',
    'echo done > .build-stamp'
  ]) {
    await allow(command);
  }
});

test('a single command still runs without a shell at all', async () => {
  const result = await allow('npm test');
  assert.equal(result.mode, 'direct', 'the stronger guarantee is kept where it applies');
  assert.equal(result.executable, 'npm');

  const composed = await allow('npm run build && npm test');
  assert.equal(composed.mode, 'shell');
});

// ─── substitution: the thing that breaks static checking ────────────────────

test('substitution is refused in every spelling', async () => {
  // Each of these produces a command while running, so no check made
  // beforehand can say what will execute.
  await refuse('echo $(whoami)', /substitution/);
  await refuse('cat `id`', /substitution/);
  await refuse('diff <(ls a) <(ls b)', /substitution/);
  await refuse('tee >(cat)', /substitution/);
  await refuse('npm test\nrm -rf .', /newline/);
});

test('every segment is checked, not just the first', async () => {
  // The first command being harmless is exactly how this would be smuggled.
  await refuse('ls && curl https://example.com/x', /curl/);
  await refuse('echo hi | sh', /sh/);
  await refuse('npm test; sudo rm -rf /', /sudo/);
  await refuse('true && true && wget http://x', /wget/);
});

test('a command cannot be left running after the task', async () => {
  await refuse('npm run dev &', /background/);
  await refuse('sleep 100 & echo done', /background/);
});

// ─── staying inside the workspace ───────────────────────────────────────────

test('redirection cannot write outside the workspace', async () => {
  await refuse('echo x > /etc/passwd', /outside the project workspace/);
  await refuse('echo x > ~/.bashrc', /outside the project workspace/);
  await refuse('echo x > ../../escape.txt', /outside the project workspace/);
  await refuse('cat secrets > /root/steal', /outside the project workspace/);
});

test('the one absolute path anybody needs is allowed', async () => {
  await allow('npm test > /dev/null');
  await allow('npm test 2>/dev/null || echo failed');
  assert.equal(redirectAllowed('/dev/null'), true);
  assert.equal(redirectAllowed('build/log.txt'), true);
  assert.equal(redirectAllowed('/etc/passwd'), false);
  assert.equal(redirectAllowed('../out.txt'), false);
});

test('arguments still cannot point outside the workspace', async () => {
  await refuse('zip -r out.zip ../../etc', /outside the project workspace/);
  await refuse('cat /etc/shadow', /outside the project workspace/);
});

// ─── risk ───────────────────────────────────────────────────────────────────

test('the riskiest segment sets the risk for the line', async () => {
  const safe = await allow('ls && cat package.json');
  assert.equal(safe.risk, 'safe');

  const destructive = await allow('npm test && rm -rf dist');
  assert.equal(destructive.risk, 'destructive', 'a harmless first command must not hide a destructive second');

  const install = await allow('echo start && npm install');
  assert.equal(install.risk, 'install');
});

test('find -exec asks first', async () => {
  // It runs a command the allowlist never saw, which is the one hole that
  // composition cannot close. Available, but not silent.
  const result = await allow('find . -name "*.tmp" -exec rm {} ;');
  assert.equal(result.risk, 'destructive');
});

// ─── the lexer ──────────────────────────────────────────────────────────────

test('quoting decides what is an operator', () => {
  const { tokens } = lex('echo "a && b" | grep a');
  const operators = tokens.filter(token => token.operator).map(token => token.value);
  assert.deepEqual(operators, ['|'], 'a quoted && is an argument, not a separator');

  const { segments } = segment(tokens);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].args, ['a && b']);
});

test('a file descriptor join is one token, not a redirect and a background', () => {
  // `1>&2` split badly used to read as "redirect, then run in background".
  const { tokens } = lex('echo err 1>&2 2>&1 | cat');
  const operators = tokens.filter(token => token.operator).map(token => token.value);
  assert.deepEqual(operators, ['1>&2', '2>&1', '|']);

  const { segments } = segment(tokens);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].args, ['err'], 'the stream number is not an argument');
});

test('an unclosed quote is a parse error, not a guess', () => {
  assert.match(lex('echo "unterminated').error, /unclosed quote/);
});

test('redirect targets are collected, not mistaken for arguments', () => {
  const { segments } = segment(lex('npm run build > build.log 2>> err.log').tokens);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].args, ['run', 'build']);
  assert.deepEqual(segments[0].redirects, ['build.log', 'err.log']);
});

test('a dangling operator does not become a silent no-op', () => {
  assert.ok(segment(lex('&& npm test').tokens).error);
  assert.ok(segment(lex('npm test >').tokens).error);
});

test('substitution is detected before anything is parsed', () => {
  assert.equal(findSubstitution('echo $(id)'), 'command substitution');
  assert.equal(findSubstitution('echo `id`'), 'backtick substitution');
  assert.equal(findSubstitution('echo ${HOME}'), null, 'plain variable expansion is not substitution');
  assert.equal(findSubstitution('npm test'), null);
});

test('an empty or oversized command is refused', async () => {
  await refuse('', /empty/);
  await refuse('   ', /empty/);
  await refuse(`echo ${'x'.repeat(5000)}`, /too long/);
});
