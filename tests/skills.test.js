/**
 * Skills.
 *
 * The claim is an economic one: the craft that makes a piece of work good is
 * too specific to live in a system prompt and too valuable to leave out. So
 * an index travels and a body is fetched. The tests check the index stays
 * small, the bodies stay loadable, and a project can override ours — which is
 * the part that decides whether a team can actually use this.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'dirox-skills-'));
process.env.WORKSPACE_ROOT = root;

const { ensureWorkspace, writeWorkspaceFile } = await import('../src/exec/workspace.js');
const {
  parseSkill, builtInSkills, projectSkills, availableSkills, skillIndex, loadSkill
} = await import('../src/agent/skills.js');
const { estimateTokens } = await import('../src/ai/pricing.js');

const PROJECT = '11111111-2222-3333-4444-aaaaaaaaaaaa';
const BARE = '11111111-2222-3333-4444-bbbbbbbbbbbb';

before(async () => {
  await ensureWorkspace(PROJECT);
  await ensureWorkspace(BARE);
  await writeWorkspaceFile(PROJECT, '.dirox/skills/design.md', [
    '---',
    'name: design',
    'description: Our house style.',
    'when: any UI work in this repository.',
    '---',
    '',
    '# Our design',
    'Everything is teal. Nothing is round.'
  ].join('\n'));
  await writeWorkspaceFile(PROJECT, '.dirox/skills/deploy.md', [
    '---',
    'name: deploy',
    'when: shipping this service.',
    '---',
    '',
    'Run `make release`, then watch the dashboard for ten minutes.'
  ].join('\n'));
});

after(() => rm(root, { recursive: true, force: true }));

// ─── the format ─────────────────────────────────────────────────────────────

test('front matter is read, and the body is what follows it', () => {
  const skill = parseSkill('---\nname: Testing\ndescription: How.\nwhen: writing tests.\n---\n\n# Body\n\nText.', 'fallback');
  assert.equal(skill.name, 'testing');
  assert.equal(skill.description, 'How.');
  assert.equal(skill.when, 'writing tests.');
  assert.equal(skill.body, '# Body\n\nText.');
});

test('a file with no front matter is still a skill', () => {
  // Somebody writing a skill in a text editor should not have to read
  // documentation to produce something that loads.
  const skill = parseSkill('Just some guidance.\n', 'house-style');
  assert.equal(skill.name, 'house-style');
  assert.equal(skill.body, 'Just some guidance.');
});

test('a name is reduced to something safe to address', () => {
  assert.equal(parseSkill('---\nname: My Skill!! \n---\nx', 'x').name, 'my-skill--');
});

// ─── what ships ─────────────────────────────────────────────────────────────

test('the platform ships skills, and each one has a body', async () => {
  const skills = await builtInSkills();
  assert.ok(skills.length >= 5, `only ${skills.length} built-in skills`);

  for (const skill of skills) {
    assert.ok(skill.when, `${skill.name} does not say when it applies`);
    assert.ok(skill.body.length > 400, `${skill.name} is ${skill.body.length} characters, which is not a skill`);
    assert.equal(skill.source, 'built-in');
  }

  assert.ok(skills.some(skill => skill.name === 'design'));
  assert.ok(skills.some(skill => skill.name === 'testing'));
});

test('the index is cheap enough to send every time', async () => {
  const index = skillIndex(await builtInSkills());
  const tokens = estimateTokens(index);

  // It sits in the cached system prefix, so it is paid for about once per run
  // — but a prefix that grows is a prefix that stops being worth caching.
  assert.ok(tokens < 300, `the skills index is ${tokens} tokens`);
  assert.match(index, /load_skill/);
});

test('the index says when to use a skill, not what it contains', async () => {
  const index = skillIndex(await builtInSkills());
  // The decision being made is "does this apply to what I am doing".
  assert.match(index, /- design: writing or changing any UI/);
});

// ─── a project's own ────────────────────────────────────────────────────────

test('a project can add skills of its own', async () => {
  const skills = await projectSkills(PROJECT);
  assert.deepEqual(skills.map(skill => skill.name).sort(), ['deploy', 'design']);
  assert.equal(skills[0].source, 'project');
});

test('a project\'s version of a name wins', async () => {
  /*
     This is the part that decides whether a team can use this at all. Our
     design skill is a general one; theirs is their house style, and a house
     style beats a general one every time.
  */
  const skills = await availableSkills(PROJECT);
  const design = skills.find(skill => skill.name === 'design');

  assert.equal(design.source, 'project');
  assert.match(design.body, /Everything is teal/);
  assert.ok(!design.body.includes('WCAG'), 'the built-in skill was merged into the project\'s');

  // And the ones they did not override are still there.
  assert.ok(skills.some(skill => skill.name === 'testing' && skill.source === 'built-in'));
});

test('a project with no skills directory is the ordinary case', async () => {
  assert.deepEqual(await projectSkills(BARE), []);
  const skills = await availableSkills(BARE);
  assert.ok(skills.length >= 5);
  assert.ok(skills.every(skill => skill.source === 'built-in'));
});

test('a skill is loaded by name, and an unknown name is not guessed at', async () => {
  const skill = await loadSkill('DESIGN', PROJECT);
  assert.equal(skill.name, 'design');
  assert.equal(skill.source, 'project');

  assert.equal(await loadSkill('nonexistent', PROJECT), null);
  assert.equal(await loadSkill('', PROJECT), null);
});

test('skills are available without a project at all', async () => {
  const skills = await availableSkills(null);
  assert.ok(skills.length >= 5);
});
