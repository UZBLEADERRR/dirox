/**
 * Workspace isolation.
 *
 * Each project gets a directory under WORKSPACE_ROOT. Every path a tool touches
 * is resolved and checked to be inside that directory — there is exactly one
 * function that turns a caller-supplied path into a real path, and it refuses
 * anything that escapes, including through symlinks.
 */

import { access, mkdir, readdir, readFile, realpath, rm, stat, writeFile, rename, constants } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config/env.js';
import { AppError, badRequest, forbidden, notFound, payloadTooLarge } from '../core/errors.js';
import { logger } from '../core/logger.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Directories never walked, indexed or shown in the file tree. */
export const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', 'out', 'target',
  'coverage', '.cache', '.turbo', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'vendor', '.gradle', '.idea', '.vscode', 'Pods', '.terraform', '.serverless',
  'bower_components', '.parcel-cache', '.svelte-kit', '.output', 'tmp', '.tmp'
]);

/** Files whose contents must never be read into a model prompt. */
export const SECRET_FILE_PATTERN = /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials(\.json)?|service-account.*\.json)$/i;

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc',
  '.cpp', '.hpp', '.cs', '.php', '.scala', '.ex', '.exs', '.erl', '.dart', '.lua',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
  '.md', '.mdx', '.rst', '.txt', '.sql', '.graphql', '.gql', '.proto',
  '.xml', '.svg', '.gitignore', '.dockerignore', '.editorconfig', '.env.example'
]);

export function isTextFile(path) {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Extensionless files that are conventionally text.
  const base = path.split('/').pop() || '';
  return /^(Dockerfile|Makefile|Procfile|Rakefile|Gemfile|Jenkinsfile|LICENSE|README|CHANGELOG|\.?[a-z]+rc)$/i.test(base);
}

export function isSecretPath(path) { return SECRET_FILE_PATTERN.test(path); }

export function workspaceRoot() { return resolve(config.sandbox.workspaceRoot); }

export function workspacePath(projectId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(projectId))) throw badRequest('Invalid project identifier');
  return join(workspaceRoot(), projectId);
}

export async function ensureWorkspace(projectId) {
  const dir = workspacePath(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function workspaceExists(projectId) {
  try { await access(workspacePath(projectId), constants.R_OK); return true; }
  catch { return false; }
}

/**
 * The single trusted path resolver.
 * @returns {Promise<string>} an absolute path guaranteed to be inside the workspace
 */
export async function resolveInside(projectId, relativePath) {
  const root = workspacePath(projectId);
  const requested = String(relativePath ?? '');
  if (requested.includes('\0')) throw badRequest('Path contains an invalid character');

  const candidate = resolve(root, requested.replace(/^[/\\]+/, ''));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw forbidden('That path is outside the project workspace');
  }

  // Symlinks are resolved for any part of the path that already exists, so a
  // link planted inside the workspace cannot point out of it.
  let existing = candidate;
  for (;;) {
    try {
      const real = await realpath(existing);
      const realRoot = await realpath(root);
      const tail = relative(existing, candidate);
      const finalPath = tail ? join(real, tail) : real;
      if (finalPath !== realRoot && !finalPath.startsWith(`${realRoot}${sep}`)) {
        throw forbidden('That path resolves outside the project workspace');
      }
      return candidate;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const parent = dirname(existing);
      if (parent === existing) return candidate;   // nothing on this path exists yet
      existing = parent;
    }
  }
}

export function toRelative(projectId, absolutePath) {
  return relative(workspacePath(projectId), absolutePath).split(sep).join('/');
}

// ─── file operations ────────────────────────────────────────────────────────

export async function readWorkspaceFile(projectId, path, { maxBytes = MAX_FILE_BYTES, allowSecret = false } = {}) {
  if (!allowSecret && isSecretPath(path)) {
    throw forbidden('This file may contain credentials and cannot be read by the agent');
  }
  const full = await resolveInside(projectId, path);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw notFound(`File not found: ${path}`);
  if (info.size > maxBytes) throw payloadTooLarge(`${path} is ${Math.round(info.size / 1024)}KB, larger than the ${Math.round(maxBytes / 1024)}KB read limit`);

  const content = await readFile(full, 'utf8');
  return {
    path: String(path).replace(/^[/\\]+/, ''),
    content,
    size: info.size,
    lines: content.length ? content.split('\n').length : 0,
    hash: hashContent(content),
    modifiedAt: info.mtime.toISOString()
  };
}

export async function writeWorkspaceFile(projectId, path, content, { createDirectories = true } = {}) {
  if (isSecretPath(path)) throw forbidden('Writing credential files is not permitted');
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw payloadTooLarge('File content exceeds the 2MB write limit');

  const full = await resolveInside(projectId, path);
  if (createDirectories) await mkdir(dirname(full), { recursive: true });

  const previous = await readFile(full, 'utf8').catch(() => null);
  await writeFile(full, text, 'utf8');

  return {
    path: String(path).replace(/^[/\\]+/, ''),
    created: previous === null,
    bytes: Buffer.byteLength(text),
    hash: hashContent(text),
    previousHash: previous === null ? null : hashContent(previous)
  };
}

export async function deleteWorkspacePath(projectId, path) {
  const full = await resolveInside(projectId, path);
  if (full === workspacePath(projectId)) throw forbidden('The workspace root cannot be deleted');
  const info = await stat(full).catch(() => null);
  if (!info) throw notFound(`Nothing to delete at ${path}`);
  await rm(full, { recursive: info.isDirectory(), force: false });
  return { path, wasDirectory: info.isDirectory() };
}

export async function moveWorkspacePath(projectId, from, to) {
  const source = await resolveInside(projectId, from);
  const target = await resolveInside(projectId, to);
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
  return { from, to };
}

/**
 * Walk the workspace.
 * @returns {Promise<Array<{path:string,size:number,isDirectory:boolean,modifiedAt:string}>>}
 */
export async function listWorkspace(projectId, { maxEntries = 5000, includeDirectories = false, subPath = '' } = {}) {
  const start = await resolveInside(projectId, subPath);
  const root = workspacePath(projectId);
  const entries = [];
  const stack = [start];

  while (stack.length && entries.length < maxEntries) {
    const dir = stack.pop();
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const item of items) {
      if (entries.length >= maxEntries) break;
      if (IGNORED_DIRECTORIES.has(item.name)) continue;
      if (item.isSymbolicLink()) continue;      // never follow links out of the tree

      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join('/');

      if (item.isDirectory()) {
        stack.push(full);
        if (includeDirectories) entries.push({ path: rel, size: 0, isDirectory: true, modifiedAt: null });
        continue;
      }
      if (!item.isFile()) continue;

      const info = await stat(full).catch(() => null);
      if (!info) continue;
      entries.push({ path: rel, size: info.size, isDirectory: false, modifiedAt: info.mtime.toISOString() });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, truncated: entries.length >= maxEntries };
}

export async function workspaceSize(projectId) {
  const { entries } = await listWorkspace(projectId, { maxEntries: 20_000 });
  return entries.reduce((total, entry) => total + entry.size, 0);
}

export async function removeWorkspace(projectId) {
  const dir = workspacePath(projectId);
  await rm(dir, { recursive: true, force: true });
  logger.info('workspace removed', { projectId });
}

export function hashContent(content) {
  return createHash('sha256').update(String(content)).digest('hex').slice(0, 32);
}

export { MAX_FILE_BYTES };
