/**
 * Project inspection, memory and security tools.
 *
 * These answer questions about the project without reading many files, which
 * is exactly the point: `inspect_project` costs a few hundred tokens where
 * reading package.json, the config files and the directory tree would cost
 * thousands.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { detectProject } from '../../context/detect.js';
import { readWorkspaceFile, listWorkspace } from '../../exec/workspace.js';
import { runCommand } from '../../exec/sandbox.js';
import { sanitise } from '../prompts.js';

export const projectTools = [
  {
    name: 'inspect_project',
    risk: RISK.SAFE,
    description:
      'Get the project\'s language, framework, package manager, commands, entry points and directory layout in one call. ' +
      'Use this before exploring files individually.',
    schema: t.object({}),
    async run(_args, ctx) {
      const detected = await detectProject(ctx.projectId);

      const lines = [
        detected.language && `Language: ${detected.language}`,
        detected.framework && `Framework: ${detected.framework}`,
        detected.packageManager && `Package manager: ${detected.packageManager}`,
        detected.testCommand && `Test: ${detected.testCommand}`,
        detected.buildCommand && `Build: ${detected.buildCommand}`,
        detected.devCommand && `Dev server: ${detected.devCommand}`,
        detected.entryPoints.length && `Entry points: ${detected.entryPoints.join(', ')}`,
        `Files: ${detected.fileCount}`,
        detected.evidence.length && `Detected from: ${detected.evidence.join(', ')}`
      ].filter(Boolean);

      const dependencies = Object.keys(detected.dependencies || {});
      if (dependencies.length) {
        lines.push(`Key dependencies: ${dependencies.slice(0, 25).join(', ')}${dependencies.length > 25 ? `, and ${dependencies.length - 25} more` : ''}`);
      }

      const { entries } = await listWorkspace(ctx.projectId, { maxEntries: 2000, includeDirectories: true });
      const roots = new Map();
      for (const entry of entries) {
        const root = entry.path.split('/')[0];
        if (entry.path.includes('/')) roots.set(root, (roots.get(root) || 0) + 1);
      }
      const layout = [...roots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      if (layout.length) lines.push(`Layout: ${layout.map(([dir, count]) => `${dir}/ (${count})`).join(', ')}`);

      return { output: lines.join('\n'), metadata: { ...detected, dependencies: undefined } };
    }
  },

  {
    name: 'inspect_dependencies',
    risk: RISK.SAFE,
    description: 'List the project\'s declared dependencies and their versions.',
    schema: t.object({ filter: t.string({ max: 80, description: 'Only show dependencies whose name contains this' }) }),
    async run({ filter }, ctx) {
      const manifests = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile'];
      for (const path of manifests) {
        const file = await readWorkspaceFile(ctx.projectId, path).catch(() => null);
        if (!file) continue;

        if (path === 'package.json') {
          const manifest = JSON.parse(file.content);
          const all = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
          const filtered = Object.entries(all).filter(([name]) => !filter || name.includes(filter));
          return {
            output: filtered.length
              ? filtered.map(([name, version]) => `${name}@${version}`).join('\n')
              : `No dependency matches "${filter}".`,
            metadata: { manifest: path, count: filtered.length }
          };
        }

        const lines = file.content.split('\n').filter(line => !filter || line.includes(filter));
        return { output: lines.slice(0, 200).join('\n'), metadata: { manifest: path } };
      }
      return { output: 'No dependency manifest was found in this project.', metadata: {} };
    }
  },

  {
    name: 'remember',
    risk: RISK.WRITE,
    description:
      'Record something durable about this project: an architecture decision, a convention, a known bug, or a solution ' +
      'that worked. It will be available in future tasks. Never store credentials.',
    schema: t.object({
      kind: t.enum(['architecture', 'convention', 'rule', 'dependency', 'bug', 'deployment', 'solution', 'note'], { required: true }),
      content: t.string({ required: true, max: 1000 }),
      key: t.string({ max: 60, description: 'Optional stable key so this replaces an earlier note on the same topic' })
    }),
    async run({ kind, content, key }, ctx) {
      if (!hasServiceRole()) throw badRequest('Project memory is unavailable on this deployment');

      if (/(?:api[_-]?key|secret|password|bearer|token)\s*[:=]\s*\S/i.test(content)) {
        throw badRequest('Project memory must never contain credentials.');
      }

      const clean = sanitise(content, 1000);
      await serviceClient().insert('project_memory', {
        project_id: ctx.projectId,
        scope: 'project',
        kind,
        key: key || null,
        content: clean,
        tokens: Math.ceil(clean.length / 4),
        importance: kind === 'architecture' || kind === 'rule' ? 0.8 : 0.6,
        source: 'agent'
      }, { upsert: Boolean(key), onConflict: key ? 'project_id,kind,key' : undefined, returning: false });

      return { output: `Recorded (${kind}): ${clean.slice(0, 120)}`, metadata: { kind, key } };
    }
  },

  {
    name: 'recall',
    risk: RISK.SAFE,
    description: 'Look up what has been recorded about this project previously.',
    schema: t.object({
      kind: t.enum(['architecture', 'convention', 'rule', 'dependency', 'bug', 'deployment', 'solution', 'note']),
      query: t.string({ max: 120 })
    }),
    async run({ kind, query }, ctx) {
      if (!hasServiceRole()) return { output: 'Project memory is unavailable.', metadata: {} };

      let request = serviceClient().from('project_memory')
        .select('kind,key,content,created_at')
        .eq('project_id', ctx.projectId).eq('scope', 'project');
      if (kind) request = request.eq('kind', kind);
      if (query) request = request.like('content', query);

      const rows = await request.order('importance').limit(20).all();
      if (!rows.length) return { output: 'Nothing has been recorded about this yet.', metadata: { matches: 0 } };

      return {
        output: rows.map(row => `[${row.kind}] ${row.content}`).join('\n'),
        metadata: { matches: rows.length }
      };
    }
  },

  {
    name: 'dependency_audit',
    risk: RISK.SAFE,
    description: 'Check the project\'s dependencies for known vulnerabilities.',
    schema: t.object({}),
    async run(_args, ctx) {
      const manager = ctx.project?.package_manager;
      const command = { npm: 'npm audit --json', pnpm: 'pnpm audit --json', yarn: 'yarn npm audit --json' }[manager];
      if (!command) return { output: `Dependency auditing is not available for ${manager || 'this project type'}.`, metadata: {} };

      const result = await runCommand(ctx.projectId, command, { timeoutMs: 120_000, maxOutput: 40_000, signal: ctx.signal });

      try {
        const report = JSON.parse(result.stdout);
        const counts = report.metadata?.vulnerabilities || {};
        const total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
        if (!total) return { output: 'No known vulnerabilities in the dependency tree.', metadata: { total: 0 } };

        const summary = Object.entries(counts).filter(([, n]) => n).map(([level, n]) => `${n} ${level}`).join(', ');
        return { output: `${total} known vulnerabilities: ${summary}`, metadata: { total, counts } };
      } catch {
        return { output: result.output.slice(0, 4000) || 'The audit produced no parseable output.', metadata: {} };
      }
    }
  },

  {
    name: 'secret_scan',
    risk: RISK.SAFE,
    description: 'Scan tracked files for credentials that should not be committed. Reports locations only, never values.',
    schema: t.object({}),
    async run(_args, ctx) {
      const patterns = [
        [/\b(?:sk|pk)-[A-Za-z0-9]{20,}\b/, 'API key'],
        [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
        [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
        [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
        [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'JWT'],
        [/(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i, 'hardcoded credential']
      ];

      const { entries } = await listWorkspace(ctx.projectId, { maxEntries: 2000 });
      const findings = [];

      for (const entry of entries) {
        if (findings.length >= 50 || entry.size > 300_000) continue;
        if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|zip|lock)$/i.test(entry.path)) continue;

        const file = await readWorkspaceFile(ctx.projectId, entry.path, { allowSecret: true }).catch(() => null);
        if (!file) continue;

        const lines = file.content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          for (const [pattern, label] of patterns) {
            if (!pattern.test(lines[i])) continue;
            // The location, never the value.
            findings.push(`${entry.path}:${i + 1} — possible ${label}`);
            break;
          }
          if (findings.length >= 50) break;
        }
      }

      if (!findings.length) return { output: 'No credential-shaped strings were found.', metadata: { findings: 0 } };
      return {
        output: `${findings.length} possible credential(s) found. Rotate anything real and move it to environment configuration.\n${findings.join('\n')}`,
        metadata: { findings: findings.length }
      };
    }
  }
];
