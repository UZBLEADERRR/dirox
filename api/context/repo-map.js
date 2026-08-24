import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';

const DEFAULT_IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache']);
const DEFAULT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.md', '.sql', '.py', '.go', '.java']);
const MAX_FILE_BYTES = 512 * 1024;

function inside(root, candidate) {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(`${r}${sep}`);
}

export function safeRepoPath(rootDir, filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0')) return null;
  const root = resolve(rootDir);
  const candidate = resolve(root, filePath);
  return inside(root, candidate) ? candidate : null;
}

function symbolsFrom(source, language) {
  const symbols = [];
  const patterns = language === '.py'
    ? [/^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/gm, /^\s*class\s+([A-Za-z_$][\w$]*)/gm]
    : [/^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/gm, /^\s*(?:export\s+)?class\s+([\w$]+)/gm, /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/gm, /^\s*(?:export\s+)?(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{/gm];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source))) {
      const line = source.slice(0, match.index).split('\n').length;
      if (!symbols.some(item => item.name === match[1] && item.line === line)) symbols.push({ name: match[1], line });
    }
  }
  return symbols.sort((a, b) => a.line - b.line).slice(0, 300);
}

async function walk(root, current, options, result) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (options.ignored.has(entry.name)) continue;
    const full = resolve(current, entry.name);
    if (!inside(root, full)) continue;
    if (entry.isDirectory()) { await walk(root, full, options, result); continue; }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (options.extensions && !options.extensions.has(extension)) continue;
    try {
      const info = await stat(full);
      if (info.size > options.maxFileBytes) {
        result.push({ path: relative(root, full).split(sep).join('/'), size: info.size, extension, tooLarge: true, symbols: [] });
        continue;
      }
      const source = await readFile(full, 'utf8');
      result.push({ path: relative(root, full).split(sep).join('/'), size: info.size, extension, lines: source.split('\n').length, symbols: symbolsFrom(source, extension) });
    } catch { /* files can disappear while a map is being built */ }
  }
}

export async function buildRepoMap(rootDir, options = {}) {
  const root = resolve(rootDir);
  const opts = { ignored: DEFAULT_IGNORED, extensions: DEFAULT_EXTENSIONS, maxFileBytes: MAX_FILE_BYTES, ...options };
  opts.ignored = new Set(opts.ignored || []);
  opts.extensions = opts.extensions ? new Set(opts.extensions) : null;
  const result = [];
  try { await walk(root, root, opts, result); } catch { return { root: rootDir, files: [], error: 'Repository is not readable' }; }
  result.sort((a, b) => a.path.localeCompare(b.path));
  return { root: rootDir, files: result, fileCount: result.length, generatedAt: new Date().toISOString() };
}

export async function readRepoFile(rootDir, filePath, maxChars = 30000) {
  const full = safeRepoPath(rootDir, filePath);
  if (!full) return null;
  try { const text = await readFile(full, 'utf8'); return text.slice(0, Math.max(0, maxChars)); } catch { return null; }
}

export { symbolsFrom };
