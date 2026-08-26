# Architecture

DiroxCode is a modular agent platform. Each component is replaceable
independently, and nothing is coupled to a single AI provider.

```
                      browser (ES modules, no build step)
                                   │
                    ┌──────────────┴──────────────┐
                    │       HTTP kernel           │  cors → headers → rate
                    │      (src/core/http.js)     │  limit → auth → handler
                    └──────────────┬──────────────┘
         ┌─────────────┬───────────┼───────────┬──────────────┐
      auth /        projects /   agent /     admin /       billing /
      users         github       tasks       models        webhooks
         │             │           │            │              │
         └─────────────┴─────┬─────┴────────────┴──────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   Context Engine      Agent Orchestrator     AI Gateway
   retrieval           classify → plan →      routing, retries,
   budget              tools → validate       fallback, usage ledger
        │                    │                    │
        │              Tool Executor         Provider adapters
        │              permissions,          openai · anthropic
        │              timeouts, limits      google (+ compatible)
        │                    │
        └────────────┬───────┴──────────┐
                     │                  │
              Workspace (isolated)   Sandbox (allowlist, no shell)
                     │
        ┌────────────┴────────────┐
   Supabase Postgres          Job queue
   RLS on every tenant table  FOR UPDATE SKIP LOCKED
```

---

## Request pipeline

One order, applied to every request, in `src/app.js`:

```
CORS → security headers → rate limit → authentication → handler → error mapping
```

Handlers declare what they need (`{ auth: 'write' }`, `{ rateLimit: 'agent' }`)
and the kernel applies it. That keeps the entire attack surface reviewable in
`src/routes.js`, and a test asserts every route has made a decision.

---

## Token efficiency

The single design constraint that shapes the most code. Four mechanisms:

### 1. Retrieval instead of dumping

Repositories are indexed into files, symbols and an import graph. For a task,
`rankFiles()` scores every candidate with five cheap signals — exact paths named
in the request, keyword matches on paths and symbols, declared-symbol matches,
one-hop dependency expansion, and recency. **No model call is involved in
deciding what to retrieve**; that would defeat the purpose.

`buildContext()` then takes whole files only when they are small or strongly
matched, and otherwise takes just the matched symbol ranges plus a few lines of
surrounding code. Overlapping ranges merge; identical content deduplicates by
hash. Everything that does not fit becomes a one-line reference, so the model
knows a file exists and can ask for it rather than being told nothing.

### 2. Routing instead of always reaching for the best model

Every request is classified into a category and one of five complexity levels.
Heuristics settle the large majority at zero cost and report a confidence; a
classifier model is called only when that confidence is genuinely low.

Routing rules live in the database, so an administrator changes them without a
redeploy. Escalation to a stronger model happens **only after two measured
failures**, never speculatively, and never past a configured attempt limit.

### 3. A budget the agent can see

Each task carries a budget in micro-USD. `TokenBudget.limits()` converts what
remains into concrete numbers: context tokens, output tokens, file count,
retrieval depth, tool output size, history length. Those limits are the minimum
of the configured ceiling, the model's own context window less an output
reserve, and what the remaining money can actually pay for.

The agent is told its own pressure — *comfortable*, *tightening*, *critical* —
so it degrades deliberately rather than failing when the money runs out.

### 4. Compression everywhere else

Conversation history older than the recent window collapses to summary lines.
Tool output keeps its head and tail, never the middle of a 50,000-line build
log. Deterministic calls — classification, titling, summarisation — are cached
within the tenant. Prompt caching is used where the provider supports it.

---

## The agent loop

```
classify → plan → retrieve → model → tools → observe → validate → review → report
```

Safety properties, all in `src/agent/orchestrator.js`:

- **Iteration limit**, configurable, capped at 40.
- **Loop detection.** The same action repeated beyond a threshold stops the run
  and says so, rather than burning budget.
- **Checkpoint before the first change.** A git patch when available, captured
  file contents otherwise; restorable either way.
- **Approval pauses the run** and persists it, rather than guessing. The task
  resumes exactly where it stopped when approved.
- **Validation is real.** Tests run through the project's own configured
  command, and the result reported is the result observed.

---

## Data model

Normalised, in eight ordered migrations. The shape worth knowing:

- **Tenancy.** `organizations` → `organization_members` → everything else. Every
  tenant table's RLS policy resolves through one of three `SECURITY DEFINER`
  predicates.
- **Projects.** `projects` → `files` → `code_symbols`, `file_dependencies`.
  File *contents* are not stored — only metadata, a hash and a summary. Content
  is read from the workspace on demand.
- **Tasks.** `tasks` → `task_steps` → `tool_calls` → `tool_results`. The whole
  timeline is reconstructable, which is what makes the activity view honest.
- **Cost.** `usage_records` is the single source of truth, written for every
  model call including failures. `usage_daily` is an atomic rollup so dashboards
  never scan the raw ledger.
- **Configuration as data.** `plans`, `model_providers`, `models`,
  `model_routes`, `feature_flags`, `system_settings`. No pricing, limit or
  routing decision is hardcoded.

---

## Scaling path

| Load | Change |
| --- | --- |
| 100 users | One process. Web, API and worker together. |
| 10,000 users | Split the worker (`WORKER_ENABLED=false` on web). Scale web horizontally. |
| 100,000+ users | Add worker replicas per queue; add a Postgres read replica for dashboards; move `ai_cache` to Redis. |

The API is stateless apart from two in-memory caches, and both degrade
correctly across instances: per-instance rate limits multiply by instance count
while durable per-plan quotas stay exact in Postgres.

---

## What is deliberately not here

- **No build step.** The client is ES modules served directly. Cold start is
  immediate and there is no bundler to keep working.
- **No runtime dependencies.** The server uses only the Node standard library.
  Nothing to audit, nothing to patch on a Friday.
- **No ORM.** A thin PostgREST query builder that escapes filter values, which
  is what actually matters, and nothing that hides what a query costs.
- **No framework on the client.** `h()` builds nodes and escapes by
  construction, which removes an XSS class outright rather than mitigating it.
