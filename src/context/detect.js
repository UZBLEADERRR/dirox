/**
 * Project detection.
 *
 * Language, framework, package manager and the commands a contributor would
 * actually run. This is read from real manifest files — nothing is guessed, and
 * an undetected field stays null rather than being filled with a plausible lie.
 */

import { readWorkspaceFile, listWorkspace } from '../exec/workspace.js';

const LANGUAGE_BY_EXTENSION = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.kt': 'Kotlin', '.kts': 'Kotlin', '.swift': 'Swift', '.cs': 'C#', '.php': 'PHP',
  '.scala': 'Scala', '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
  '.vue': 'Vue', '.svelte': 'Svelte'
};

/** Dependency name -> framework label, checked in order of specificity. */
const JS_FRAMEWORKS = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@angular/core', 'Angular'],
  ['@remix-run/react', 'Remix'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'],
  ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'],
  ['koa', 'Koa'], ['hono', 'Hono'], ['react-native', 'React Native'],
  ['vue', 'Vue'], ['svelte', 'Svelte'], ['react', 'React']
];

const PY_FRAMEWORKS = [
  ['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask'],
  ['starlette', 'Starlette'], ['pyramid', 'Pyramid']
];

const TEST_RUNNERS = [
  ['vitest', 'npx vitest run'], ['jest', 'npx jest'], ['mocha', 'npx mocha'],
  ['@playwright/test', 'npx playwright test'], ['ava', 'npx ava']
];

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function read(projectId, path) {
  try { return (await readWorkspaceFile(projectId, path, { allowSecret: false })).content; }
  catch { return null; }
}

async function detectPackageManager(projectId, files) {
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun';
  if (files.has('package-lock.json')) return 'npm';
  const manifest = parseJson((await read(projectId, 'package.json')) || '');
  if (manifest?.packageManager) return String(manifest.packageManager).split('@')[0];
  return files.has('package.json') ? 'npm' : null;
}

function runScript(manager, script) {
  if (!manager) return null;
  if (manager === 'npm') return `npm run ${script}`;
  return `${manager} run ${script}`;
}

/**
 * @returns {Promise<{language,framework,packageManager,testCommand,buildCommand,devCommand,entryPoints,dependencies,evidence}>}
 */
export async function detectProject(projectId) {
  const { entries } = await listWorkspace(projectId, { maxEntries: 4000 });
  const files = new Set(entries.map(entry => entry.path));
  const evidence = [];

  // ── language: by file count, weighted so config files do not dominate ──
  const counts = new Map();
  for (const entry of entries) {
    const dot = entry.path.lastIndexOf('.');
    if (dot < 0) continue;
    const language = LANGUAGE_BY_EXTENSION[entry.path.slice(dot).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const language = ranked[0]?.[0] ?? null;
  if (language) evidence.push(`${ranked[0][1]} ${language} files`);

  const result = {
    language,
    framework: null,
    packageManager: await detectPackageManager(projectId, files),
    testCommand: null,
    buildCommand: null,
    devCommand: null,
    entryPoints: [],
    dependencies: {},
    fileCount: entries.length,
    sizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    evidence
  };

  // ── JavaScript / TypeScript ecosystem ──
  const manifest = parseJson((await read(projectId, 'package.json')) || '');
  if (manifest) {
    const dependencies = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
    result.dependencies = dependencies;
    evidence.push('package.json');

    for (const [name, label] of JS_FRAMEWORKS) {
      if (dependencies[name]) { result.framework = label; evidence.push(`depends on ${name}`); break; }
    }

    const scripts = manifest.scripts || {};
    if (scripts.test) result.testCommand = runScript(result.packageManager, 'test');
    else {
      const runner = TEST_RUNNERS.find(([name]) => dependencies[name]);
      if (runner) result.testCommand = runner[1];
    }
    if (scripts.build) result.buildCommand = runScript(result.packageManager, 'build');
    if (scripts.dev) result.devCommand = runScript(result.packageManager, 'dev');
    else if (scripts.start) result.devCommand = runScript(result.packageManager, 'start');

    if (manifest.main) result.entryPoints.push(manifest.main);
    for (const candidate of ['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'index.js', 'app/page.tsx', 'src/App.tsx', 'server.js']) {
      if (files.has(candidate)) result.entryPoints.push(candidate);
    }
  }

  // ── Python ──
  if (!result.framework) {
    const pyproject = await read(projectId, 'pyproject.toml');
    const requirements = await read(projectId, 'requirements.txt');
    const pySource = `${pyproject || ''}\n${requirements || ''}`.toLowerCase();
    if (pySource.trim()) {
      evidence.push(pyproject ? 'pyproject.toml' : 'requirements.txt');
      result.packageManager ??= pyproject?.includes('[tool.poetry]') ? 'poetry' : 'pip';
      for (const [name, label] of PY_FRAMEWORKS) {
        if (pySource.includes(name)) { result.framework = label; evidence.push(`depends on ${name}`); break; }
      }
      if (pySource.includes('pytest')) result.testCommand ??= 'pytest';
      if (files.has('manage.py')) { result.devCommand ??= 'python manage.py runserver'; result.entryPoints.push('manage.py'); }
    }
  }

  // ── other ecosystems ──
  const others = [
    ['go.mod', 'Go', null, 'go test ./...', 'go build ./...', 'go run .'],
    ['Cargo.toml', 'Rust', 'cargo', 'cargo test', 'cargo build', 'cargo run'],
    ['pom.xml', 'Java', 'maven', 'mvn test', 'mvn package', null],
    ['build.gradle', 'Java', 'gradle', './gradlew test', './gradlew build', null],
    ['build.gradle.kts', 'Kotlin', 'gradle', './gradlew test', './gradlew build', null],
    ['composer.json', 'PHP', 'composer', 'vendor/bin/phpunit', null, null],
    ['Gemfile', 'Ruby', 'bundler', 'bundle exec rspec', null, null]
  ];
  for (const [marker, lang, manager, test, build, dev] of others) {
    if (!files.has(marker)) continue;
    evidence.push(marker);
    result.language ??= lang;
    result.packageManager ??= manager;
    result.testCommand ??= test;
    result.buildCommand ??= build;
    result.devCommand ??= dev;
    if (marker === 'composer.json' && files.has('artisan')) result.framework ??= 'Laravel';
    if (marker === 'Gemfile') {
      const gemfile = (await read(projectId, 'Gemfile')) || '';
      if (/rails/i.test(gemfile)) result.framework ??= 'Rails';
    }
  }

  // ── .NET ──
  const csproj = entries.find(entry => entry.path.endsWith('.csproj') || entry.path.endsWith('.sln'));
  if (csproj) {
    evidence.push(csproj.path);
    result.language ??= 'C#';
    result.framework ??= '.NET';
    result.testCommand ??= 'dotnet test';
    result.buildCommand ??= 'dotnet build';
  }

  result.entryPoints = [...new Set(result.entryPoints)].slice(0, 8);
  result.evidence = [...new Set(evidence)].slice(0, 10);
  return result;
}
