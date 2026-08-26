/**
 * Repository indexer.
 *
 * Runs as a background job. Builds the file table, the symbol table and the
 * import graph, and computes a cheap importance score used to rank retrieval.
 *
 * Incremental by content hash: a file whose hash is unchanged is skipped
 * entirely, so re-indexing a large repository after a small change is cheap.
 */

import { serviceClient } from '../db/supabase.js';
import { listWorkspace, readWorkspaceFile, isTextFile, isSecretPath, hashContent } from '../exec/workspace.js';
import { extractSymbols, extractImports, resolveImport } from './symbols.js';
import { detectProject } from './detect.js';
import { logger } from '../core/logger.js';
import { caches } from '../core/cache.js';

const MAX_INDEXED_FILES = 6000;
const MAX_FILE_BYTES = 512 * 1024;
const BATCH = 200;

const LANGUAGE_BY_EXTENSION = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.swift': 'swift', '.cs': 'csharp', '.php': 'php',
  '.vue': 'vue', '.svelte': 'svelte', '.css': 'css', '.scss': 'scss',
  '.html': 'html', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown', '.sql': 'sql', '.sh': 'shell'
};

const GENERATED_PATTERN = /(^|\/)(dist|build|out|generated|__generated__|\.next|migrations)\/|\.(min|bundle|generated|lock)\.|-lock\.(json|yaml)$|\.d\.ts$/i;

/**
 * Importance drives retrieval ranking before any model is involved.
 * Entry points, config and heavily-imported files rank above leaf utilities.
 */
function importanceOf(path, { symbolCount, lineCount, isGenerated, entryPoints }) {
  if (isGenerated) return 0.05;
  let score = 0.3;

  const depth = path.split('/').length;
  score += Math.max(0, 0.2 - depth * 0.03);

  if (entryPoints.includes(path)) score += 0.35;
  if (/(^|\/)(index|main|app|server|router|routes)\.[jt]sx?$/.test(path)) score += 0.2;
  if (/(^|\/)(package\.json|tsconfig\.json|next\.config\.|vite\.config\.|pyproject\.toml|go\.mod|Cargo\.toml)/.test(path)) score += 0.25;
  if (/(^|\/)README\.md$/i.test(path)) score += 0.2;
  if (/\.(test|spec)\./.test(path) || /(^|\/)(tests?|__tests__)\//.test(path)) score -= 0.15;
  if (/(^|\/)(types?|constants?|utils?|helpers?)\//.test(path)) score -= 0.05;

  score += Math.min(0.2, symbolCount * 0.01);
  if (lineCount > 800) score -= 0.1;

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function languageOf(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? null;
}

/**
 * Index a project's workspace into the database.
 * @param {string} projectId
 * @param {{ full?: boolean, onProgress?: (p:object)=>void }} options
 */
export async function indexProject(projectId, { full = false, onProgress } = {}) {
  const client = serviceClient();
  const started = Date.now();

  await client.from('projects').eq('id', projectId).update({ index_status: 'running', index_error: null });
  caches.index.invalidatePrefix(`project:${projectId}`);

  try {
    const detected = await detectProject(projectId);
    const { entries, truncated } = await listWorkspace(projectId, { maxEntries: MAX_INDEXED_FILES });

    const candidates = entries.filter(entry =>
      !entry.isDirectory &&
      entry.size <= MAX_FILE_BYTES &&
      isTextFile(entry.path) &&
      !isSecretPath(entry.path)
    );

    // Existing index, so unchanged files can be skipped.
    const existing = new Map();
    if (!full) {
      const rows = await client.from('files').select('id,path,content_hash').eq('project_id', projectId).limit(1000).all();
      for (const row of rows) existing.set(row.path, row);
    } else {
      await client.from('files').eq('project_id', projectId).remove();
    }

    const known = new Set(candidates.map(entry => entry.path));
    const fileRows = [];
    const symbolsByPath = new Map();
    const importsByPath = new Map();
    let changed = 0;
    let skipped = 0;

    for (const entry of candidates) {
      let content;
      try { ({ content } = await readWorkspaceFile(projectId, entry.path, { maxBytes: MAX_FILE_BYTES })); }
      catch { continue; }

      const hash = hashContent(content);
      const previous = existing.get(entry.path);
      if (previous && previous.content_hash === hash) { skipped += 1; existing.delete(entry.path); continue; }

      const symbols = extractSymbols(content, entry.path);
      const imports = extractImports(content, entry.path);
      const isGenerated = GENERATED_PATTERN.test(entry.path);
      const lineCount = content.length ? content.split('\n').length : 0;

      symbolsByPath.set(entry.path, symbols);
      importsByPath.set(entry.path, imports);

      fileRows.push({
        project_id: projectId,
        path: entry.path,
        directory: entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '',
        extension: entry.path.includes('.') ? entry.path.slice(entry.path.lastIndexOf('.')) : null,
        language: languageOf(entry.path),
        size_bytes: entry.size,
        line_count: lineCount,
        content_hash: hash,
        importance: importanceOf(entry.path, {
          symbolCount: symbols.length, lineCount, isGenerated, entryPoints: detected.entryPoints
        }),
        is_generated: isGenerated,
        last_modified_at: entry.modifiedAt,
        indexed_at: new Date().toISOString()
      });
      changed += 1;

      if (onProgress && changed % 100 === 0) onProgress({ indexed: changed, total: candidates.length });
    }

    // Files that disappeared from the workspace.
    const removedPaths = [...existing.keys()];
    if (removedPaths.length) {
      for (let i = 0; i < removedPaths.length; i += BATCH) {
        await client.from('files').eq('project_id', projectId).in('path', removedPaths.slice(i, i + BATCH)).remove();
      }
    }

    // Upsert files in batches, then symbols and dependencies per file.
    const pathToId = new Map();
    for (let i = 0; i < fileRows.length; i += BATCH) {
      const inserted = await client.insert('files', fileRows.slice(i, i + BATCH), {
        upsert: true, onConflict: 'project_id,path'
      });
      for (const row of Array.isArray(inserted) ? inserted : [inserted]) {
        if (row?.id) pathToId.set(row.path, row.id);
      }
    }
    // Unchanged files still need their ids for the dependency graph.
    if (pathToId.size < known.size) {
      const rows = await client.from('files').select('id,path').eq('project_id', projectId).limit(1000).all();
      for (const row of rows) pathToId.set(row.path, row.id);
    }

    const changedIds = [...symbolsByPath.keys()].map(path => pathToId.get(path)).filter(Boolean);
    for (let i = 0; i < changedIds.length; i += BATCH) {
      const batch = changedIds.slice(i, i + BATCH);
      await client.from('code_symbols').eq('project_id', projectId).in('file_id', batch).remove();
      await client.from('file_dependencies').eq('project_id', projectId).in('from_file_id', batch).remove();
    }

    const symbolRows = [];
    const dependencyRows = [];
    for (const [path, symbols] of symbolsByPath) {
      const fileId = pathToId.get(path);
      if (!fileId) continue;
      for (const symbol of symbols.slice(0, 300)) {
        symbolRows.push({
          project_id: projectId, file_id: fileId, name: symbol.name, kind: symbol.kind,
          signature: symbol.signature, start_line: symbol.startLine, end_line: symbol.endLine,
          is_exported: symbol.isExported
        });
      }
      for (const dependency of importsByPath.get(path) || []) {
        const resolved = dependency.external ? null : resolveImport(path, dependency.target, known);
        dependencyRows.push({
          project_id: projectId, from_file_id: fileId, to_path: dependency.target,
          to_file_id: resolved ? pathToId.get(resolved) ?? null : null,
          kind: dependency.external ? 'package' : 'import'
        });
      }
    }

    for (let i = 0; i < symbolRows.length; i += BATCH) {
      await client.insert('code_symbols', symbolRows.slice(i, i + BATCH), { returning: false });
    }
    for (let i = 0; i < dependencyRows.length; i += BATCH) {
      await client.insert('file_dependencies', dependencyRows.slice(i, i + BATCH), {
        upsert: true, onConflict: 'project_id,from_file_id,to_path', returning: false
      });
    }

    const { total: symbolCount } = await client.from('code_symbols').select('id').eq('project_id', projectId).count().run('GET');

    await client.from('projects').eq('id', projectId).update({
      index_status: truncated ? 'stale' : 'ready',
      status: 'ready',
      indexed_at: new Date().toISOString(),
      file_count: candidates.length,
      symbol_count: symbolCount ?? symbolRows.length,
      size_bytes: detected.sizeBytes,
      language: detected.language,
      framework: detected.framework,
      package_manager: detected.packageManager,
      test_command: detected.testCommand,
      build_command: detected.buildCommand,
      dev_command: detected.devCommand,
      index_error: truncated ? `Only the first ${MAX_INDEXED_FILES} files were indexed` : null,
      health: {
        detectedFrom: detected.evidence,
        entryPoints: detected.entryPoints,
        indexedAt: new Date().toISOString(),
        durationMs: Date.now() - started
      }
    });

    caches.index.invalidatePrefix(`project:${projectId}`);

    const summary = {
      files: candidates.length, changed, skipped, removed: removedPaths.length,
      symbols: symbolRows.length, dependencies: dependencyRows.length,
      truncated, durationMs: Date.now() - started, detected
    };
    logger.info('project indexed', { projectId, ...summary, detected: undefined });
    return summary;
  } catch (error) {
    await client.from('projects').eq('id', projectId).update({
      index_status: 'failed',
      index_error: String(error?.message || error).slice(0, 500)
    }).catch(() => {});
    throw error;
  }
}

export { MAX_INDEXED_FILES, importanceOf, languageOf };
