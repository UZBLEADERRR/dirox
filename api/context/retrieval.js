import { readRepoFile } from './repo-map.js';

const DEFAULTS = { maxChars: 12000, maxFiles: 8, maxSymbols: 24, linesAround: 10 };
const words = value => String(value || '').toLowerCase().match(/[a-z0-9_$-]{2,}/g) || [];

function scoreFile(file, queryWords) {
  const path = file.path.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (path === word || path.includes(word)) score += path.endsWith(word) ? 8 : 4;
    for (const symbol of file.symbols || []) if (symbol.name.toLowerCase().includes(word)) score += 3;
  }
  if (score && /^(readme|package\.json|api\/server)/i.test(file.path)) score += 1;
  return score;
}

export function rankRepoFiles(repoMap, query, limit = 8) {
  const queryWords = words(query);
  return (repoMap?.files || []).map(file => ({ ...file, score: scoreFile(file, queryWords) }))
    .filter(file => file.score > 0 || queryWords.length === 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.max(0, limit));
}

function excerpt(source, start, end) {
  const lines = source.split('\n');
  const from = Math.max(0, start - 1);
  const to = Math.min(lines.length, end);
  return { text: lines.slice(from, to).join('\n'), startLine: from + 1, endLine: to };
}

export async function retrieveContext({ rootDir, repoMap, query = '', maxChars = DEFAULTS.maxChars, maxFiles = DEFAULTS.maxFiles, maxSymbols = DEFAULTS.maxSymbols, linesAround = DEFAULTS.linesAround } = {}) {
  const budget = Math.max(0, Number(maxChars) || DEFAULTS.maxChars);
  const selected = rankRepoFiles(repoMap, query, maxFiles);
  const q = words(query);
  const items = [];
  let used = 0;
  for (const file of selected) {
    if (used >= budget || !rootDir || file.tooLarge) continue;
    const source = await readRepoFile(rootDir, file.path, Math.min(100000, budget - used + 2000));
    if (source == null) continue;
    const hits = (file.symbols || []).filter(symbol => !q.length || q.some(word => symbol.name.toLowerCase().includes(word))).slice(0, maxSymbols);
    const ranges = hits.length ? hits.map(symbol => ({ ...excerpt(source, symbol.line - linesAround, symbol.line + linesAround), symbol: symbol.name })) : [{ ...excerpt(source, 1, Math.min(80, source.split('\n').length)), symbol: null }];
    for (const range of ranges) {
      if (used >= budget) break;
      const text = range.text.slice(0, budget - used);
      if (!text) break;
      items.push({ path: file.path, score: file.score, symbol: range.symbol, startLine: range.startLine, endLine: range.startLine + text.split('\n').length - 1, text });
      used += text.length;
    }
  }
  return { query: String(query), items, chars: used, truncated: used >= budget };
}

export { words };
