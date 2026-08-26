# DiroxCode

**Your AI Software Engineer.**

DiroxCode is a production-grade AI software engineering platform. You connect a
project, describe what you want in plain language, and an autonomous agent
plans the work, retrieves only the code it actually needs, edits files, runs
tests, fixes what it broke, reviews the result and reports back — with the
cost and token usage of the whole run.

It is not a chat window with a code block. It is an agent with tools,
boundaries, a budget and an audit trail.

---

## What makes it different

**Token efficiency is an architectural constraint, not a setting.**
Repositories are indexed into files, symbols and an import graph. Hybrid
retrieval (exact + keyword + symbol + dependency + recency) selects a small,
ranked, deduplicated context for each task. Whole repositories are never sent
to a model.

**The cheapest capable model wins.** Every request is classified into one of
five complexity levels and routed by an admin-editable rule table. Escalation
to a stronger model happens only after a measured failure, never speculatively.

**Every task has a budget.** The agent knows what it has spent and what remains.
As the budget tightens it compresses context, drops to a cheaper model and stops
redundant retries rather than silently burning money.

**Repository content is data, never instructions.** System policy, developer
policy, user intent, repository text and tool output are separated at the prompt
boundary. A README cannot tell the agent to exfiltrate a key.

---

## Architecture

```
web/                     Single-page client (ES modules, no build step)
  styles/                Design tokens, components, layout, workspace
  app/lib/               api client, store, router, dom, formatting
  app/components/        shell, command palette, brand
  app/pages/             landing, auth, home, projects, workspace, admin…

src/                     Node server (zero runtime dependencies)
  config/                Environment and capability reporting
  core/                  http kernel, errors, logger, validation, cache,
                         rate limiting, crypto
  db/                    Supabase/PostgREST client (user-scoped + service role)
  modules/               auth, users, orgs, projects, agent, billing, admin,
                         notifications, observability
  ai/                    Provider adapters, gateway, model router, pricing
  agent/                 Orchestrator, planner, tools, permissions, checkpoints
  context/               Indexer, symbols, retrieval, summarisation, budget
  exec/                  Sandboxed command execution and workspace isolation
  queue/                 Postgres-backed job queue and worker

db/migrations/           Ordered, idempotent SQL — schema, RLS, seed data
docs/                    Architecture, security model, deployment, roadmap
tests/                   node:test suites
```

One process serves the API, the static client and the job worker. Set
`WORKER_ENABLED=false` to run web and worker as separate Railway services when
you outgrow a single instance.

---

## Deployment

DiroxCode runs on **Supabase** (Postgres, Auth, Row Level Security) and
**Railway** (the Node service). See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the
full walkthrough.

### 1. Supabase

Run the migrations in `db/migrations/` in filename order in the SQL editor.
They are idempotent, so re-running one is safe.

Then grant yourself admin access:

```sql
insert into platform_admins (user_id, role)
values ('<your-auth-user-uuid>', 'superadmin');
```

### 2. Railway

Deploy this repository. `npm start` is the start command and `/api/health` is
the health check. Set the environment variables from
[`.env.example`](.env.example) — at minimum:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Public anon key (RLS applies) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only. System writes, admin, queue |
| `DIROX_ENCRYPTION_KEY` | 32-byte base64 key for secrets at rest |
| `APP_URL` | Public URL, used for OAuth redirects |
| `CORS_ORIGINS` | Comma-separated allowed browser origins |
| `OPENROUTER_API_KEY` | Or any other provider key referenced by `key_ref` |

The server starts even when optional integrations are missing: it reports
degraded capabilities at boot and the UI disables what is unavailable instead
of pretending it works.

### 3. First run

Sign up, connect a repository, and give DiroxCode a task.

---

## Security

- Row Level Security on every tenant table; organization ids from the client are
  always re-verified against membership.
- Provider keys, GitHub tokens and billing secrets never reach the browser.
  Secrets at rest are AES-256-GCM encrypted.
- Access tokens are held in memory by the client; the refresh token is an
  HttpOnly, SameSite=Strict cookie.
- Commands run against an allowlist inside an isolated workspace with CPU,
  memory, output and time limits. Destructive operations require approval.
- Sign-ins, model changes, Git operations, billing changes and admin actions
  are audited.

Full model: [`docs/SECURITY.md`](docs/SECURITY.md).

---

## Development

```bash
npm start          # serve API + client on :3000
npm run dev        # same, with --watch
npm test           # node:test suites
npm run check      # syntax check every source file
```

There is no build step and no runtime dependency tree. Node 20+ is the only
requirement.
