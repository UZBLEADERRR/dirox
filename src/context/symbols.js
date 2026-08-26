/**
 * Lightweight symbol and dependency extraction.
 *
 * A full parser per language would be the "right" answer and the wrong
 * trade-off here: this runs on every indexed file and must stay fast and
 * dependency-free. The patterns are conservative — they under-report rather
 * than inventing symbols that do not exist, because a wrong symbol sends the
 * retriever (and the model) to the wrong place.
 */

const LIMIT = 400;

function lineOf(source, index, lineStarts) {
  // Binary search the precomputed line offsets.
  let low = 0, high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= index) low = mid; else high = mid - 1;
  }
  return low + 1;
}

function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

/** Approximate the end of a block by brace or indentation depth. */
function blockEnd(source, startIndex, lineStarts, startLine, style) {
  if (style === 'indent') {
    const lines = source.split('\n');
    const startText = lines[startLine - 1] ?? '';
    const indent = startText.match(/^\s*/)[0].length;
    for (let i = startLine; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (line.match(/^\s*/)[0].length <= indent) return i;
    }
    return lines.length;
  }

  let depth = 0;
  let seen = false;
  for (let i = startIndex; i < source.length && i < startIndex + 20_000; i += 1) {
    const char = source[i];
    if (char === '{') { depth += 1; seen = true; }
    else if (char === '}') {
      depth -= 1;
      if (seen && depth <= 0) return lineOf(source, i, lineStarts);
    }
  }
  return Math.min(lineOf(source, source.length - 1, lineStarts), startLine + 200);
}

const JS_PATTERNS = [
  { kind: 'function', re: /^[ \t]*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm, nameGroup: 4, exportGroup: 1 },
  { kind: 'class', re: /^[ \t]*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, nameGroup: 4, exportGroup: 1 },
  { kind: 'interface', re: /^[ \t]*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, nameGroup: 2, exportGroup: 1 },
  { kind: 'type', re: /^[ \t]*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm, nameGroup: 2, exportGroup: 1 },
  { kind: 'const', re: /^[ \t]*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm, nameGroup: 2, exportGroup: 1 },
  { kind: 'const', re: /^[ \t]*(export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*=/gm, nameGroup: 2, exportGroup: 1 }
];

const PY_PATTERNS = [
  { kind: 'function', re: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm, nameGroup: 1 },
  { kind: 'class', re: /^[ \t]*class\s+([A-Za-z_][\w]*)/gm, nameGroup: 1 }
];

const GO_PATTERNS = [
  { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm, nameGroup: 1 },
  { kind: 'type', re: /^type\s+([A-Za-z_][\w]*)/gm, nameGroup: 1 }
];

const RUST_PATTERNS = [
  { kind: 'function', re: /^[ \t]*(pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm, nameGroup: 2, exportGroup: 1 },
  { kind: 'class', re: /^[ \t]*(pub\s+)?struct\s+([A-Za-z_][\w]*)/gm, nameGroup: 2, exportGroup: 1 },
  { kind: 'interface', re: /^[ \t]*(pub\s+)?trait\s+([A-Za-z_][\w]*)/gm, nameGroup: 2, exportGroup: 1 }
];

const JVM_PATTERNS = [
  { kind: 'class', re: /^[ \t]*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|data\s+|sealed\s+)?class\s+([A-Za-z_][\w]*)/gm, nameGroup: 1 },
  { kind: 'interface', re: /^[ \t]*(?:public\s+)?interface\s+([A-Za-z_][\w]*)/gm, nameGroup: 1 },
  { kind: 'method', re: /^[ \t]+(?:public|private|protected)\s+(?:static\s+)?[\w<>,\[\]. ]+\s+([A-Za-z_][\w]*)\s*\(/gm, nameGroup: 1 }
];

const PHP_PATTERNS = [
  { kind: 'class', re: /^[ \t]*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/gm, nameGroup: 1 },
  { kind: 'function', re: /^[ \t]*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_][\w]*)/gm, nameGroup: 1 }
];

const RUBY_PATTERNS = [
  { kind: 'class', re: /^[ \t]*class\s+([A-Z][\w:]*)/gm, nameGroup: 1 },
  { kind: 'function', re: /^[ \t]*def\s+(self\.)?([A-Za-z_][\w?!]*)/gm, nameGroup: 2 }
];

function patternsFor(extension) {
  switch (extension) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
    case '.mts': case '.cts': case '.vue': case '.svelte':
      return { patterns: JS_PATTERNS, style: 'brace' };
    case '.py': return { patterns: PY_PATTERNS, style: 'indent' };
    case '.go': return { patterns: GO_PATTERNS, style: 'brace' };
    case '.rs': return { patterns: RUST_PATTERNS, style: 'brace' };
    case '.java': case '.kt': case '.kts': case '.scala': case '.cs': case '.swift':
      return { patterns: JVM_PATTERNS, style: 'brace' };
    case '.php': return { patterns: PHP_PATTERNS, style: 'brace' };
    case '.rb': return { patterns: RUBY_PATTERNS, style: 'indent' };
    default: return null;
  }
}

/** Components and routes get their own kind so retrieval can prefer them. */
function refineKind(kind, name, path) {
  if (/\.(test|spec)\.[jt]sx?$/.test(path) || /(^|\/)(tests?|__tests__)\//.test(path)) return 'test';
  if (/(^|\/)(routes?|api|pages|app)\//.test(path) && ['function', 'const'].includes(kind)) return 'route';
  if (kind === 'const' && /^[A-Z][A-Za-z0-9]*$/.test(name) && /\.(tsx|jsx|vue|svelte)$/.test(path)) return 'component';
  if (kind === 'function' && /^[A-Z]/.test(name) && /\.(tsx|jsx)$/.test(path)) return 'component';
  return kind;
}

/**
 * @returns {Array<{name,kind,startLine,endLine,isExported,signature}>}
 */
export function extractSymbols(source, path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  const config = patternsFor(extension);
  if (!config || !source) return [];

  const lineStarts = lineStartsOf(source);
  const found = new Map();

  for (const pattern of config.patterns) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(source)) && found.size < LIMIT) {
      const name = match[pattern.nameGroup];
      if (!name || name.length > 80) continue;

      const startLine = lineOf(source, match.index, lineStarts);
      const key = `${name}:${startLine}`;
      if (found.has(key)) continue;

      const signature = (source.slice(match.index, source.indexOf('\n', match.index) === -1 ? undefined : source.indexOf('\n', match.index)) || '').trim().slice(0, 200);

      found.set(key, {
        name,
        kind: refineKind(pattern.kind, name, path),
        startLine,
        endLine: blockEnd(source, match.index, lineStarts, startLine, config.style),
        isExported: pattern.exportGroup ? Boolean(match[pattern.exportGroup]) : true,
        signature
      });
    }
  }

  return [...found.values()].sort((a, b) => a.startLine - b.startLine);
}

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/gm,       // ESM
  /^\s*(?:const|let|var)\s+.*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm, // CJS
  /^\s*export\s+.*\s+from\s+['"]([^'"]+)['"]/gm,                      // re-export
  /^\s*from\s+([\w.]+)\s+import\s+/gm,                                // Python
  /^\s*import\s+([\w.]+)$/gm,                                         // Python plain
  /^\s*use\s+([\w:]+)/gm                                              // Rust
];

/**
 * @returns {Array<{target:string, external:boolean}>}
 */
export function extractImports(source, path) {
  if (!source) return [];
  const results = new Map();

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) && results.size < 200) {
      const target = match[1];
      if (!target) continue;
      const relative = target.startsWith('.') || target.startsWith('/') || target.startsWith('@/') || target.startsWith('~/');
      results.set(target, { target, external: !relative });
    }
  }

  return [...results.values()];
}

/**
 * Resolve a relative import to a real indexed path.
 * @param {string} fromPath   the importing file
 * @param {string} target     the import specifier
 * @param {Set<string>} known every indexed path
 */
export function resolveImport(fromPath, target, known) {
  let base;
  if (target.startsWith('@/') || target.startsWith('~/')) base = target.slice(2);
  else if (target.startsWith('/')) base = target.slice(1);
  else if (target.startsWith('.')) {
    const dir = fromPath.split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') dir.pop();
      else dir.push(part);
    }
    base = dir.join('/');
  } else {
    return null;   // a package, not a file in this repository
  }

  if (known.has(base)) return base;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.go', '.rs'];
  for (const extension of extensions) {
    if (known.has(base + extension)) return base + extension;
    if (known.has(`${base}/index${extension}`)) return `${base}/index${extension}`;
  }
  // Python dotted paths.
  const dotted = base.replace(/\./g, '/');
  for (const extension of ['.py']) {
    if (known.has(dotted + extension)) return dotted + extension;
    if (known.has(`${dotted}/__init__${extension}`)) return `${dotted}/__init__${extension}`;
  }
  return null;
}

export { LIMIT };
