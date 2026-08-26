/**
 * File tools.
 *
 * `edit_file` is the primary editing tool and takes an exact string
 * replacement rather than a whole-file rewrite: it is dramatically cheaper in
 * output tokens and it fails loudly when the model's assumption about the
 * current content is wrong, instead of silently clobbering the file.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import {
  readWorkspaceFile, writeWorkspaceFile, deleteWorkspacePath,
  moveWorkspacePath, listWorkspace, isTextFile, isSecretPath
} from '../../exec/workspace.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';

export const fileTools = [
  {
    name: 'read_file',
    risk: RISK.SAFE,
    description: 'Read a file from the project. Use only when the file is not already in your context.',
    schema: t.object({
      path: t.string({ required: true, max: 400, description: 'Path relative to the project root' }),
      startLine: t.integer({ min: 1, description: 'Optional first line to read' }),
      endLine: t.integer({ min: 1, description: 'Optional last line to read' })
    }),
    async run({ path, startLine, endLine }, ctx) {
      const file = await readWorkspaceFile(ctx.projectId, path);
      if (!startLine && !endLine) {
        return { output: file.content, metadata: { path, lines: file.lines, bytes: file.size } };
      }
      const lines = file.content.split('\n');
      const from = Math.max(1, startLine || 1);
      const to = Math.min(lines.length, endLine || lines.length);
      return {
        output: lines.slice(from - 1, to).join('\n'),
        metadata: { path, startLine: from, endLine: to, totalLines: lines.length }
      };
    }
  },

  {
    name: 'write_file',
    risk: RISK.WRITE,
    description: 'Create a file, or replace its entire contents. Prefer edit_file for changes to an existing file.',
    schema: t.object({
      path: t.string({ required: true, max: 400 }),
      content: t.string({ required: true, max: 400_000, trim: false })
    }),
    async run({ path, content }, ctx) {
      await ctx.beforeFileChange?.(path);
      const result = await writeWorkspaceFile(ctx.projectId, path, content);
      ctx.recordFileChange(path, result.created ? 'created' : 'modified');
      return {
        output: `${result.created ? 'Created' : 'Rewrote'} ${path} (${result.bytes} bytes)`,
        metadata: result
      };
    }
  },

  {
    name: 'edit_file',
    risk: RISK.WRITE,
    description:
      'Replace an exact string in a file. `oldText` must match the current contents exactly and appear exactly once. ' +
      'This is the cheapest and safest way to change code.',
    schema: t.object({
      path: t.string({ required: true, max: 400 }),
      oldText: t.string({ required: true, max: 100_000, trim: false, description: 'Exact text to replace, including indentation' }),
      newText: t.string({ required: true, max: 100_000, trim: false, description: 'Replacement text' })
    }),
    async run({ path, oldText, newText }, ctx) {
      await ctx.beforeFileChange?.(path);
      const file = await readWorkspaceFile(ctx.projectId, path);

      const occurrences = file.content.split(oldText).length - 1;
      if (occurrences === 0) {
        throw conflict(
          `The text to replace was not found in ${path}. Read the file again — its contents differ from what you expected.`
        );
      }
      if (occurrences > 1) {
        throw conflict(
          `The text to replace appears ${occurrences} times in ${path}. Include more surrounding lines so the match is unique.`
        );
      }

      const updated = file.content.replace(oldText, newText);
      const result = await writeWorkspaceFile(ctx.projectId, path, updated);
      ctx.recordFileChange(path, 'modified');

      const linesBefore = file.content.slice(0, file.content.indexOf(oldText)).split('\n').length;
      return {
        output: `Edited ${path} at line ${linesBefore}`,
        metadata: { ...result, line: linesBefore, removed: oldText.split('\n').length, added: newText.split('\n').length }
      };
    }
  },

  {
    name: 'create_file',
    risk: RISK.WRITE,
    description: 'Create a new file. Fails if it already exists.',
    schema: t.object({
      path: t.string({ required: true, max: 400 }),
      content: t.string({ required: true, max: 400_000, trim: false })
    }),
    async run({ path, content }, ctx) {
      const existing = await readWorkspaceFile(ctx.projectId, path).catch(() => null);
      if (existing) throw conflict(`${path} already exists. Use edit_file or write_file to change it.`);
      await ctx.beforeFileChange?.(path);
      const result = await writeWorkspaceFile(ctx.projectId, path, content);
      ctx.recordFileChange(path, 'created');
      return { output: `Created ${path}`, metadata: result };
    }
  },

  {
    name: 'delete_file',
    risk: RISK.DESTRUCTIVE,
    description: 'Delete a file or directory. Requires approval.',
    schema: t.object({ path: t.string({ required: true, max: 400 }) }),
    async run({ path }, ctx) {
      await ctx.beforeFileChange?.(path);
      const result = await deleteWorkspacePath(ctx.projectId, path);
      ctx.recordFileChange(path, 'deleted');
      return { output: `Deleted ${path}`, metadata: result };
    }
  },

  {
    name: 'move_file',
    risk: RISK.DESTRUCTIVE,
    description: 'Move or rename a file. Requires approval.',
    schema: t.object({
      from: t.string({ required: true, max: 400 }),
      to: t.string({ required: true, max: 400 })
    }),
    async run({ from, to }, ctx) {
      await ctx.beforeFileChange?.(from);
      await ctx.beforeFileChange?.(to);
      const result = await moveWorkspacePath(ctx.projectId, from, to);
      ctx.recordFileChange(from, 'deleted');
      ctx.recordFileChange(to, 'created');
      return { output: `Moved ${from} to ${to}`, metadata: result };
    }
  },

  {
    name: 'search_files',
    risk: RISK.SAFE,
    description: 'Find files whose path matches a pattern. Use this to locate a file when you only know part of its name.',
    schema: t.object({
      pattern: t.string({ required: true, max: 120, description: 'Substring or glob-like fragment of the path' }),
      limit: t.integer({ min: 1, max: 100, default: 30 })
    }),
    async run({ pattern, limit }, ctx) {
      const needle = pattern.toLowerCase().replace(/[*?]/g, '');
      const { entries } = await listWorkspace(ctx.projectId, { maxEntries: 4000 });
      const matches = entries
        .filter(entry => entry.path.toLowerCase().includes(needle))
        .slice(0, limit);

      if (!matches.length) return { output: `No file path contains "${pattern}".`, metadata: { matches: 0 } };
      return {
        output: matches.map(entry => `${entry.path} (${entry.size} bytes)`).join('\n'),
        metadata: { matches: matches.length }
      };
    }
  },

  {
    name: 'search_code',
    risk: RISK.SAFE,
    description: 'Search file contents for a literal string or regular expression. Returns matching lines with their locations.',
    schema: t.object({
      query: t.string({ required: true, max: 200 }),
      isRegex: t.boolean({ default: false }),
      pathFilter: t.string({ max: 120, description: 'Only search files whose path contains this' }),
      limit: t.integer({ min: 1, max: 80, default: 30 })
    }),
    async run({ query, isRegex, pathFilter, limit }, ctx) {
      let matcher;
      if (isRegex) {
        try { matcher = new RegExp(query, 'i'); }
        catch { throw badRequest(`"${query}" is not a valid regular expression`); }
      }

      const { entries } = await listWorkspace(ctx.projectId, { maxEntries: 3000 });
      const candidates = entries.filter(entry =>
        isTextFile(entry.path) &&
        !isSecretPath(entry.path) &&
        entry.size < 400_000 &&
        (!pathFilter || entry.path.toLowerCase().includes(pathFilter.toLowerCase()))
      );

      const results = [];
      let filesSearched = 0;

      for (const entry of candidates) {
        if (results.length >= limit) break;
        filesSearched += 1;
        let content;
        try { ({ content } = await readWorkspaceFile(ctx.projectId, entry.path)); }
        catch { continue; }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < limit; i += 1) {
          const line = lines[i];
          const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase());
          if (hit) results.push(`${entry.path}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      }

      if (!results.length) {
        return { output: `No match for "${query}" in ${filesSearched} files.`, metadata: { matches: 0, filesSearched } };
      }
      return { output: results.join('\n'), metadata: { matches: results.length, filesSearched } };
    }
  },

  {
    name: 'find_symbol',
    risk: RISK.SAFE,
    description: 'Find where a function, class, component or type is declared. Faster and cheaper than searching file contents.',
    schema: t.object({
      name: t.string({ required: true, max: 120 }),
      kind: t.enum(['function', 'class', 'method', 'interface', 'type', 'const', 'component', 'route', 'test'])
    }),
    async run({ name, kind }, ctx) {
      if (!hasServiceRole()) throw badRequest('Symbol search requires the project index, which is not available');

      let query = serviceClient().from('code_symbols')
        .select('name,kind,signature,start_line,end_line,is_exported,files(path)')
        .eq('project_id', ctx.projectId)
        .like('name', name);
      if (kind) query = query.eq('kind', kind);

      const rows = await query.limit(25).all();
      if (!rows.length) {
        return { output: `No symbol named "${name}" is indexed. It may be dynamically defined — try search_code.`, metadata: { matches: 0 } };
      }

      const exact = rows.filter(row => row.name === name);
      const chosen = exact.length ? exact : rows;
      return {
        output: chosen
          .map(row => `${row.files?.path}:${row.start_line}-${row.end_line}  ${row.kind} ${row.name}${row.is_exported ? ' (exported)' : ''}\n  ${row.signature || ''}`)
          .join('\n'),
        metadata: { matches: chosen.length }
      };
    }
  },

  {
    name: 'list_directory',
    risk: RISK.SAFE,
    description: 'List the contents of a directory to understand the project layout.',
    schema: t.object({
      path: t.string({ max: 400, default: '', description: 'Directory relative to the project root; empty for the root' })
    }),
    async run({ path }, ctx) {
      const { entries } = await listWorkspace(ctx.projectId, { subPath: path, maxEntries: 500, includeDirectories: true });
      const prefix = path ? `${path.replace(/\/$/, '')}/` : '';
      const direct = entries.filter(entry => {
        const rest = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
        return rest && !rest.includes('/');
      });

      if (!direct.length) return { output: `${path || '.'} is empty or does not exist.`, metadata: { entries: 0 } };
      return {
        output: direct
          .map(entry => `${entry.isDirectory ? 'dir ' : 'file'}  ${entry.path}${entry.isDirectory ? '/' : ` (${entry.size} bytes)`}`)
          .join('\n'),
        metadata: { entries: direct.length }
      };
    }
  }
];
