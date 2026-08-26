# Deploying DiroxCode

DiroxCode runs on two services: **Supabase** for Postgres, authentication and
Row Level Security, and **Railway** for the Node application. Nothing else is
required to run it, and nothing else is required to run it securely.

---

## 1. Supabase

### Create the project

Create a Supabase project. From **Project Settings → API**, note:

| Value | Used as | Exposure |
| --- | --- | --- |
| Project URL | `SUPABASE_URL` | Server and browser |
| `anon` public key | `SUPABASE_ANON_KEY` | Server and browser — RLS applies |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` | **Server only. Never send to a browser.** |

The service role key bypasses Row Level Security. DiroxCode uses it only for
system writes (usage records, audit logs, the job queue) and for admin routes
that have already passed an explicit platform-admin check.

### Run the migrations

In the SQL editor, run every file in `db/migrations/` **in filename order**:

```
0001_core.sql          identity, tenancy, plans
0002_projects.sql      projects, repositories, index, memory, checkpoints
0003_agent.sql         conversations, tasks, steps, tool calls
0004_ai.sql            providers, models, routing, usage, cost
0005_platform.sql      sessions, keys, audit, notifications, jobs, billing
0006_rls.sql           Row Level Security on every tenant table
0007_seed.sql          starting plans, providers, models, routing rules
0008_integrations.sql  connected accounts (GitHub)
```

Every statement is idempotent, so re-running a file is safe.

### Grant yourself admin access

Sign up through the application first, then find your user id under
**Authentication → Users** and run:

```sql
insert into platform_admins (user_id, role)
values ('your-auth-user-uuid', 'superadmin');
```

The **Admin** entry appears in the sidebar on your next page load.

### Configure OAuth (optional)

Under **Authentication → Providers**, enable Google and/or GitHub and set the
redirect URL to `https://your-app.up.railway.app/auth/callback`.

---

## 2. Railway

Deploy this repository. `railway.json` already sets the start command
(`npm start`) and the health check (`/api/health`).

### Required variables

```bash
APP_URL=https://your-app.up.railway.app
CORS_ORIGINS=https://your-app.up.railway.app

SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# 32 random bytes, base64. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
DIROX_ENCRYPTION_KEY=...
```

**Keep `DIROX_ENCRYPTION_KEY` safe and unchanged.** It encrypts provider keys
and GitHub tokens at rest. Changing it makes every stored secret unreadable and
users will have to reconnect their accounts.

### AI provider

At least one provider key is needed for the agent to work:

```bash
OPENROUTER_API_KEY=sk-or-...
```

The seed data routes everything through OpenRouter. Other providers are
configured in **Admin → Providers**; the `key_ref` column names the environment
variable holding the key, so secrets stay in Railway rather than the database.

### GitHub (optional)

Create a GitHub OAuth App with the callback
`https://your-app.up.railway.app/api/github/callback`:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_OAUTH_CALLBACK=https://your-app.up.railway.app/api/github/callback
```

### Billing (optional)

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Add a Stripe webhook endpoint pointing at
`https://your-app.up.railway.app/api/billing/webhook`, subscribed to:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

Then set each plan's Stripe price ids in the database:

```sql
update plans set
  stripe_price_id_monthly = 'price_...',
  stripe_price_id_yearly  = 'price_...'
where code = 'pro';
```

### Sandbox

```bash
WORKSPACE_ROOT=/tmp/diroxcode-workspaces
SANDBOX_ENABLED=true
SANDBOX_TIMEOUT_MS=120000
SANDBOX_MAX_OUTPUT=20000
```

Railway's filesystem is ephemeral. Project workspaces are rebuilt from the
connected repository, so this is expected rather than a problem — but it does
mean uncommitted agent changes do not survive a restart. Attach a volume at
`WORKSPACE_ROOT` if you need them to.

---

## 3. Verify

```bash
curl https://your-app.up.railway.app/api/health
```

The response reports which capabilities are actually available:

```json
{
  "ok": true,
  "capabilities": {
    "database": true,
    "systemWrites": true,
    "encryption": true,
    "github": true,
    "billing": false,
    "sandbox": true
  }
}
```

Anything reported `false` is genuinely unavailable, and the interface disables
the corresponding features rather than offering buttons that cannot work.

Then, in the admin dashboard, open **Providers** and press **Test** on your
provider. It makes a real model call and reports latency and cost — that is the
fastest way to confirm the agent will work end to end.

---

## 4. Scaling

The application starts as one process serving the API, the client and the job
worker. Each part separates without a rewrite:

**Separate the worker.** Deploy a second Railway service from the same
repository with `WORKER_ENABLED=true` and scale the web service with
`WORKER_ENABLED=false`. Job claiming uses `SELECT … FOR UPDATE SKIP LOCKED`, so
any number of workers is safe.

**Scale the web tier.** The API is stateless apart from two in-memory caches
(rate limiting and identity), both of which degrade correctly across instances:
per-instance rate limits multiply by instance count, and durable per-plan quotas
live in Postgres where they are exact.

**Watch the right numbers.** **Admin → System** shows p50/p95/p99 latency, error
rate, queue depth and cache hit rates. **Admin → Costs** shows AI spend by
model, organization and category, with alerts when one model dominates spend or
starts failing.

---

## Environment variable reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Railway sets it | HTTP port |
| `NODE_ENV` | Recommended | `production` enables HSTS and strict CORS |
| `APP_URL` | Yes | Public URL, used for OAuth and billing redirects |
| `CORS_ORIGINS` | Yes in production | Comma-separated allowed browser origins |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Public key; RLS applies |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only; system writes, admin, queue |
| `DIROX_ENCRYPTION_KEY` | Yes | 32-byte base64 key for secrets at rest |
| `OPENROUTER_API_KEY` | One provider | Referenced by `model_providers.key_ref` |
| `OPENAI_API_KEY` etc. | Optional | Additional providers |
| `GITHUB_CLIENT_ID` / `_SECRET` | Optional | Repository import and pull requests |
| `STRIPE_SECRET_KEY` | Optional | Subscriptions |
| `STRIPE_WEBHOOK_SECRET` | With Stripe | Webhook signature verification |
| `WORKSPACE_ROOT` | Optional | Where project workspaces live |
| `SANDBOX_ENABLED` | Optional | `false` disables all command execution |
| `WORKER_ENABLED` | Optional | `false` runs web without the job worker |
| `LOG_LEVEL` | Optional | `debug`, `info`, `warn`, `error` |
