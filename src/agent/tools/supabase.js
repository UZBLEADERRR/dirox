/**
 * Tools for the user's own Supabase project.
 *
 * An application needs a database, and until now the agent could only write a
 * migration file and describe it. These close that loop: it can look at the
 * schema it is coding against and change it.
 *
 * The risk split is deliberate and follows what SQL actually does, not what it
 * looks like. Reading is safe. Writing rows is a write. Changing the shape of
 * a table, or dropping anything, is destructive and asks first — a migration
 * against a production database is the single most expensive mistake an agent
 * can make, and it is not undone by a checkpoint.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { getConnection, runSql, describeSchema } from '../../modules/projects/supabase.js';
import { readWorkspaceFile } from '../../exec/workspace.js';

/**
 * What kind of statement is this?
 *
 * Classified on the leading keyword of every statement in the script, because
 * `select 1; drop table users;` is a drop.
 */
export function classifyStatements(sql) {
  const text = String(sql || '')
    // Comments first: `-- drop table` is not a drop, and `/* */ drop` is.
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  const statements = text.split(';').map(part => part.trim()).filter(Boolean);
  const kinds = statements.map(statement => {
    const word = statement.match(/^[a-z]+/i)?.[0]?.toLowerCase() ?? '';
    if (['select', 'show', 'explain', 'with', 'values', 'table'].includes(word)) return 'read';
    if (['insert', 'update', 'delete', 'upsert', 'copy', 'merge'].includes(word)) return 'write';
    if (['create', 'alter', 'drop', 'truncate', 'grant', 'revoke', 'comment', 'refresh', 'reindex', 'vacuum'].includes(word)) return 'schema';
    return 'unknown';
  });

  return {
    statements: statements.length,
    kinds,
    readOnly: kinds.length > 0 && kinds.every(kind => kind === 'read'),
    destructive: kinds.some(kind => kind === 'schema' || kind === 'unknown')
  };
}

/** A result set the model can read, bounded so a wide table is not a wall. */
function renderRows(rows, limit = 50) {
  if (!rows?.length) return '(no rows)';
  const shown = rows.slice(0, limit);
  const columns = Object.keys(shown[0]);

  const lines = [columns.join(' | ')];
  for (const row of shown) {
    lines.push(columns.map(column => {
      const value = row[column];
      if (value === null || value === undefined) return 'null';
      return String(value).replace(/\s+/g, ' ').slice(0, 80);
    }).join(' | '));
  }
  if (rows.length > limit) lines.push(`… ${rows.length - limit} more row(s)`);
  return lines.join('\n');
}

export const supabaseTools = [
  {
    name: 'supabase_status',
    risk: RISK.SAFE,
    description: 'Check which Supabase project is connected and what it allows — reading data, running SQL, or neither.',
    schema: t.object({}),
    async run(_args, ctx) {
      const connection = await getConnection(ctx.userId);
      if (!connection) {
        return {
          ok: false,
          output: 'No Supabase project is connected. The user can connect one in Settings → Developer.'
        };
      }
      return {
        output: [
          `Connected to ${connection.ref} (${connection.projectUrl})`,
          connection.hasDatabase
            ? `SQL is available${connection.database ? ` against "${connection.database}"` : ''}.`
            : 'SQL is not available: no database connection string was provided.',
          connection.hasServiceKey ? 'The REST API is available.' : 'No service key was provided.'
        ].join('\n'),
        metadata: { ref: connection.ref, sql: connection.hasDatabase }
      };
    }
  },

  {
    name: 'supabase_schema',
    risk: RISK.SAFE,
    description: 'List the tables and columns in the connected Supabase project. Read this before writing code against the database.',
    schema: t.object({
      schema: t.string({ max: 60, default: 'public' })
    }),
    async run({ schema }, ctx) {
      const tables = await describeSchema(ctx.userId, { schema });
      if (!tables.size) return { output: `Schema "${schema}" has no tables yet.` };

      const lines = [];
      for (const [table, columns] of tables) {
        lines.push(`${table}`);
        for (const column of columns) {
          lines.push(`  ${column.name}  ${column.type}${column.nullable ? '' : ' not null'}${column.default ? ` default ${String(column.default).slice(0, 40)}` : ''}`);
        }
      }
      return {
        output: `${tables.size} table(s) in "${schema}":\n${lines.join('\n')}`,
        metadata: { tables: [...tables.keys()] }
      };
    }
  },

  {
    name: 'supabase_query',
    risk: RISK.SAFE,
    description: 'Run a read-only SQL query against the connected Supabase project. SELECT only — use supabase_execute to change anything.',
    schema: t.object({
      sql: t.string({ required: true, max: 4000, description: 'A SELECT statement' })
    }),
    async run({ sql }, ctx) {
      const shape = classifyStatements(sql);
      if (!shape.readOnly) {
        throw badRequest('supabase_query only runs SELECT. Use supabase_execute for anything that changes data or schema.');
      }
      const results = await runSql(ctx.userId, sql);
      const rows = results.flatMap(result => result.rows || []);
      return {
        output: renderRows(rows),
        metadata: { rows: rows.length }
      };
    }
  },

  {
    name: 'supabase_execute',
    // Computed per call: inserting a row and dropping a table are not the
    // same act, and calling both "write" would either block the first or wave
    // the second through.
    risk: RISK.DESTRUCTIVE,
    description:
      'Run SQL that changes the connected Supabase project: inserts, updates, or a migration that creates and alters tables. ' +
      'Schema changes ask for approval first.',
    schema: t.object({
      sql: t.string({ required: true, max: 20_000, description: 'One or more statements' }),
      why: t.string({ max: 300, description: 'One line on what this changes and why' })
    }),
    async run({ sql, why }, ctx) {
      const shape = classifyStatements(sql);
      const results = await runSql(ctx.userId, sql);

      const rows = results.flatMap(result => result.rows || []);
      const commands = results.map(result => result.command).filter(Boolean);

      return {
        output: [
          `Ran ${shape.statements} statement(s)${why ? `: ${why}` : ''}.`,
          commands.length ? commands.join(', ') : null,
          rows.length ? renderRows(rows, 20) : null
        ].filter(Boolean).join('\n'),
        metadata: { statements: shape.statements, kinds: shape.kinds, rows: rows.length }
      };
    },
    riskFor({ sql }) {
      const shape = classifyStatements(sql);
      if (shape.destructive) return RISK.DESTRUCTIVE;
      return RISK.WRITE;
    }
  },

  {
    name: 'supabase_apply_migration',
    risk: RISK.DESTRUCTIVE,
    description: 'Apply a .sql migration file from the project workspace to the connected Supabase project.',
    schema: t.object({
      path: t.string({ required: true, max: 400, description: 'Path to a .sql file in the workspace' })
    }),
    async run({ path }, ctx) {
      if (!ctx.projectId) throw badRequest('Open a project so the migration file can be read from its workspace.');
      if (!/\.sql$/i.test(path)) throw badRequest('A migration is a .sql file.');

      const file = await readWorkspaceFile(ctx.projectId, path);
      const shape = classifyStatements(file.content);
      const results = await runSql(ctx.userId, file.content);

      return {
        output: `Applied ${path}: ${shape.statements} statement(s).\n${results.map(result => result.command).filter(Boolean).join(', ')}`,
        metadata: { path, statements: shape.statements }
      };
    }
  }
];

export const SUPABASE_TOOL_NAMES = new Set(supabaseTools.map(tool => tool.name));
