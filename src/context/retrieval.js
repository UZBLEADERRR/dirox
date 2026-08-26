/**
 * Hybrid code retrieval.
 *
 * The single most important token-efficiency mechanism in DiroxCode. For a
 * given request it selects a small, ranked, deduplicated set of code — never
 * the whole repository, and never whole files when a symbol will do.
 *
 * Five independent signals are combined:
 *
 *   exact       a path or symbol the user named outright
 *   keyword     terms from the request matched against paths and symbols
 *   symbol      declared names matched against request identifiers
 *   dependency  files that import, or are imported by, an already-selected file
 *   recency     files changed recently, and files the current task touched
 *
 * Each is cheap (SQL and string matching). No model call is involved in
 * deciding what to retrieve — that would defeat the purpose.
 */

import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { readWorkspaceFile } from '../exec/workspace.js';
import { estimateTokens } from '../ai/pricing.js';
import { caches, cacheKey } from '../core/cache.js';
import { logger } from '../core/logger.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must', 'shall',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'about', 'into', 'through',
  'i', 'you', 'we', 'it', 'my', 'our', 'your', 'me', 'us', 'please', 'need', 'want',
  'make', 'get', 'let', 'use', 'using', 'add', 'new', 'code', 'file', 'files', 'project',
  'app', 'application', 'function', 'work', 'works', 'working', 'thing', 'something'
]);

/** Extract meaningful terms, keeping identifier casing information. */
export function extractTerms(text) {
  const source = String(text || '');
  const terms = new Map();

  const add = (term, weight) => {
    const key = term.toLowerCase();
    if (key.length < 3 || STOP_WORDS.has(key)) return;
    terms.set(key, Math.max(terms.get(key) || 0, weight));
  };

  // Backticked or quoted spans are near-certain references.
  for (const match of source.matchAll(/[`'"]([^`'"\n]{2,80})[`'"]/g)) add(match[1], 3);

  // Explicit paths.
  for (const match of source.matchAll(/[\w./-]+\.[a-z]{1,5}\b/gi)) add(match[0], 3);

  // camelCase / PascalCase / snake_case identifiers.
  for (const match of source.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)) {
    const word = match[0];
    const isIdentifier = /[A-Z_]/.test(word.slice(1)) || /_/.test(word);
    add(word, isIdentifier ? 2.5 : 1);
    // Split identifiers so "getUserProfile" also matches "user" and "profile".
    if (isIdentifier) {
      for (const part of word.split(/(?=[A-Z])|_/)) add(part, 1.2);
    }
  }

  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([term, weight]) => ({ term, weight }));
}

/** Paths the user named explicitly always win. */
function explicitPaths(text, knownPaths) {
  const found = new Set();
  const source = String(text || '');
  for (const path of knownPaths) {
    if (source.includes(path)) { found.add(path); continue; }
    const base = path.split('/').pop();
    if (base && base.length > 4 && new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source)) found.add(path);
  }
  return found;
}

/**
 * Rank candidate files for a request.
 *
 * @param {{projectId:string, query:string, taskFiles?:string[], limit?:number}} request
 * @returns {Promise<Array<{path,fileId,score,reasons,language,lineCount,importance}>>}
 */
export async function rankFiles({ projectId, query, taskFiles = [], limit = 40 }) {
  if (!hasServiceRole()) return [];
  const client = serviceClient();

  const files = await caches.index.wrap(cacheKey(`project:${projectId}`, 'files'), async () =>
    client.from('files')
      .select('id,path,directory,language,line_count,importance,is_generated,summary,last_modified_at')
      .eq('project_id', projectId).limit(1000).all(), 120_000);

  if (!files.length) return [];

  const symbols = await caches.index.wrap(cacheKey(`project:${projectId}`, 'symbols'), async () =>
    client.from('code_symbols')
      .select('file_id,name,kind,is_exported,start_line,end_line')
      .eq('project_id', projectId).limit(1000).all(), 120_000);

  const dependencies = await caches.index.wrap(cacheKey(`project:${projectId}`, 'deps'), async () =>
    client.from('file_dependencies')
      .select('from_file_id,to_file_id')
      .eq('project_id', projectId)
      .eq('kind', 'import')
      .limit(1000).all(), 120_000).catch(() => []);

  const terms = extractTerms(query);
  const named = explicitPaths(query, files.map(file => file.path));
  const taskFileSet = new Set(taskFiles);

  const symbolsByFile = new Map();
  for (const symbol of symbols) {
    if (!symbolsByFile.has(symbol.file_id)) symbolsByFile.set(symbol.file_id, []);
    symbolsByFile.get(symbol.file_id).push(symbol);
  }

  const now = Date.now();
  const scored = [];

  for (const file of files) {
    if (file.is_generated) continue;

    let score = 0;
    const reasons = [];
    const pathLower = file.path.toLowerCase();
    const fileSymbols = symbolsByFile.get(file.id) || [];

    // ── exact ──
    if (named.has(file.path)) { score += 100; reasons.push('named in the request'); }
    if (taskFileSet.has(file.path)) { score += 60; reasons.push('already touched by this task'); }

    // ── keyword against path ──
    let pathScore = 0;
    for (const { term, weight } of terms) {
      if (pathLower.includes(term)) pathScore += weight * (pathLower.endsWith(`/${term}`) ? 6 : 4);
    }
    if (pathScore) { score += Math.min(50, pathScore); reasons.push('path matches the request'); }

    // ── symbol ──
    let symbolScore = 0;
    const matchedSymbols = [];
    for (const symbol of fileSymbols) {
      const name = symbol.name.toLowerCase();
      for (const { term, weight } of terms) {
        if (name === term) { symbolScore += weight * 10; matchedSymbols.push(symbol); break; }
        if (name.includes(term) && term.length > 4) { symbolScore += weight * 3; matchedSymbols.push(symbol); break; }
      }
    }
    if (symbolScore) {
      score += Math.min(70, symbolScore) * (matchedSymbols.some(s => s.is_exported) ? 1.2 : 1);
      reasons.push(`defines ${matchedSymbols.slice(0, 3).map(s => s.name).join(', ')}`);
    }

    // ── summary ──
    if (file.summary) {
      const summaryLower = file.summary.toLowerCase();
      let summaryScore = 0;
      for (const { term, weight } of terms) if (summaryLower.includes(term)) summaryScore += weight;
      if (summaryScore) { score += Math.min(20, summaryScore * 2); reasons.push('summary matches'); }
    }

    // ── recency ──
    if (file.last_modified_at) {
      const ageDays = (now - new Date(file.last_modified_at).getTime()) / 86_400_000;
      if (ageDays < 7) { score += 8 - ageDays; reasons.push('changed recently'); }
    }

    // ── structural importance, as a tie-breaker only ──
    score += (file.importance || 0) * 12;

    if (score <= 0) continue;
    scored.push({
      path: file.path, fileId: file.id, score, reasons,
      language: file.language, lineCount: file.line_count,
      importance: file.importance, summary: file.summary,
      symbols: matchedSymbols.slice(0, 8)
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  // ── dependency expansion ──
  // Files that the strongest hits import are often required to make sense of
  // them. One hop only: two hops pulls in most of a repository.
  if (Array.isArray(dependencies) && dependencies.length) {
    const selectedIds = new Set(top.slice(0, 8).map(entry => entry.fileId));
    const related = new Set();
    for (const edge of dependencies) {
      if (selectedIds.has(edge.from_file_id) && edge.to_file_id) related.add(edge.to_file_id);
      if (selectedIds.has(edge.to_file_id) && edge.from_file_id) related.add(edge.from_file_id);
    }
    const byId = new Map(files.map(file => [file.id, file]));
    for (const id of related) {
      if (selectedIds.has(id) || top.some(entry => entry.fileId === id)) continue;
      const file = byId.get(id);
      if (!file || file.is_generated) continue;
      top.push({
        path: file.path, fileId: file.id, score: 5, reasons: ['imported by a relevant file'],
        language: file.language, lineCount: file.line_count, importance: file.importance,
        summary: file.summary, symbols: []
      });
      if (top.length >= limit + 8) break;
    }
  }

  return top;
}

/**
 * Turn ranked files into an actual context payload within a token budget.
 *
 * Whole files are only included when small or highly ranked; otherwise just the
 * matched symbol ranges plus a little surrounding code. Everything else is
 * represented by a one-line reference so the model knows the file exists and
 * can ask for it.
 *
 * @returns {Promise<{items:Array, tokens:number, truncated:boolean, references:Array}>}
 */
export async function buildContext({ projectId, ranked, tokenBudget = 12_000, linesAround = 6, maxFiles = 12 }) {
  const items = [];
  const references = [];
  let tokens = 0;
  let truncated = false;

  const seenHashes = new Set();

  for (const entry of ranked) {
    if (items.length >= maxFiles || tokens >= tokenBudget) {
      references.push({ path: entry.path, reason: entry.reasons[0] || 'related', symbols: entry.symbols.map(s => s.name) });
      truncated = true;
      continue;
    }

    let file;
    try { file = await readWorkspaceFile(projectId, entry.path, { maxBytes: 400 * 1024 }); }
    catch { continue; }

    const lines = file.content.split('\n');
    const wholeFileTokens = estimateTokens(file.content);
    const remaining = tokenBudget - tokens;

    // Small or strongly-matched files go in whole; the surrounding code is
    // usually what makes an edit correct.
    const takeWhole = wholeFileTokens <= Math.min(remaining, 2500) || (entry.score > 80 && wholeFileTokens <= remaining * 0.6);

    if (takeWhole) {
      const hash = file.hash;
      if (seenHashes.has(hash)) continue;   // identical content, already included
      seenHashes.add(hash);

      items.push({
        path: entry.path, kind: 'file', startLine: 1, endLine: lines.length,
        content: file.content, tokens: wholeFileTokens, reasons: entry.reasons, score: entry.score
      });
      tokens += wholeFileTokens;
      continue;
    }

    // Otherwise take the matched symbol ranges only.
    const ranges = mergeRanges(
      (entry.symbols.length ? entry.symbols : [{ start_line: 1, end_line: Math.min(lines.length, 60) }])
        .map(symbol => ({
          start: Math.max(1, symbol.start_line - linesAround),
          end: Math.min(lines.length, (symbol.end_line || symbol.start_line) + linesAround)
        }))
    );

    let included = false;
    for (const range of ranges) {
      const snippet = lines.slice(range.start - 1, range.end).join('\n');
      const snippetTokens = estimateTokens(snippet);
      if (tokens + snippetTokens > tokenBudget) { truncated = true; break; }

      items.push({
        path: entry.path, kind: 'excerpt', startLine: range.start, endLine: range.end,
        content: snippet, tokens: snippetTokens, reasons: entry.reasons, score: entry.score,
        totalLines: lines.length
      });
      tokens += snippetTokens;
      included = true;
    }

    if (!included) {
      references.push({ path: entry.path, reason: entry.reasons[0] || 'related', symbols: entry.symbols.map(s => s.name) });
    }
  }

  return { items, tokens, truncated, references };
}

/** Merge overlapping or adjacent line ranges so nothing is sent twice. */
function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end + 4) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Render the context payload as the text block sent to the model. */
export function renderContext({ items, references }, { projectSummary } = {}) {
  const sections = [];

  if (projectSummary) sections.push(`## Project\n${projectSummary}`);

  if (items.length) {
    const rendered = items.map(item => {
      const header = item.kind === 'file'
        ? `### ${item.path}`
        : `### ${item.path} (lines ${item.startLine}-${item.endLine} of ${item.totalLines})`;
      const language = item.path.split('.').pop() || '';
      return `${header}\n\`\`\`${language}\n${item.content}\n\`\`\``;
    });
    sections.push(`## Relevant code\n${rendered.join('\n\n')}`);
  }

  if (references.length) {
    const lines = references.slice(0, 25).map(ref =>
      `- ${ref.path}${ref.symbols?.length ? ` — defines ${ref.symbols.slice(0, 4).join(', ')}` : ''}`);
    sections.push(`## Other files that may be relevant\nRead them with the read_file tool if needed.\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

export { mergeRanges, STOP_WORDS };
