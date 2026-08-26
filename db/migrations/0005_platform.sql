-- ============================================================================
-- DiroxCode — 0005 platform: sessions, keys, audit, notifications, billing
-- ============================================================================

create table if not exists api_keys (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  prefix      text not null,                 -- first 8 chars, shown in the UI
  key_hash    text not null unique,          -- sha256 of the full key
  scopes      text[] not null default '{read}',
  last_used_at timestamptz,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists api_keys_org_idx on api_keys (org_id) where revoked_at is null;

-- Device/session list shown in the profile's security section.
create table if not exists user_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_hash text not null,
  ip          inet,
  user_agent  text,
  device      text,
  location    text,
  last_active_at timestamptz not null default now(),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, session_hash)
);

create index if not exists user_sessions_user_idx on user_sessions (user_id, last_active_at desc);

create table if not exists audit_logs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references organizations(id) on delete set null,
  actor_id    uuid references auth.users(id) on delete set null,
  actor_type  text not null default 'user' check (actor_type in ('user','admin','system','agent')),
  action      text not null,
  resource    text,
  resource_id text,
  severity    text not null default 'info' check (severity in ('info','warning','critical')),
  ip          inet,
  user_agent  text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_org_time_idx on audit_logs (org_id, created_at desc);
create index if not exists audit_logs_actor_idx on audit_logs (actor_id, created_at desc);
create index if not exists audit_logs_action_idx on audit_logs (action, created_at desc);

create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid references organizations(id) on delete cascade,
  kind       text not null
             check (kind in ('task_completed','task_failed','approval_required','pull_request','billing','security','system')),
  title      text not null,
  body       text not null default '',
  link       text,
  severity   text not null default 'info' check (severity in ('info','success','warning','critical')),
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;

create table if not exists feature_flags (
  key         text primary key,
  name        text not null,
  description text not null default '',
  enabled     boolean not null default false,
  -- 0..100; a stable hash of the org id decides membership in the rollout
  rollout_percentage integer not null default 100 check (rollout_percentage between 0 and 100),
  enabled_orgs uuid[] not null default '{}',
  disabled_orgs uuid[] not null default '{}',
  required_plan_codes text[] not null default '{}',
  updated_at  timestamptz not null default now()
);

drop trigger if exists feature_flags_touch on feature_flags;
create trigger feature_flags_touch before update on feature_flags for each row execute function app.touch_updated_at();

-- Durable quota counters. The in-memory limiter absorbs bursts; this survives
-- restarts and is what plan enforcement actually reads.
create table if not exists rate_limits (
  scope       text not null,        -- 'org' | 'user' | 'ip'
  scope_id    text not null,
  bucket      text not null,        -- 'tasks_day' | 'tokens_month' | 'cost_month'
  window_start timestamptz not null,
  count       bigint not null default 0,
  primary key (scope, scope_id, bucket, window_start)
);

create index if not exists rate_limits_window_idx on rate_limits (window_start);

create or replace function app.bump_rate_limit(
  p_scope text, p_scope_id text, p_bucket text, p_window timestamptz, p_amount bigint
) returns bigint
language sql security definer set search_path = public as $$
  insert into rate_limits (scope, scope_id, bucket, window_start, count)
  values (p_scope, p_scope_id, p_bucket, p_window, p_amount)
  on conflict (scope, scope_id, bucket, window_start)
  do update set count = rate_limits.count + excluded.count
  returning count;
$$;

-- ─── billing documents ──────────────────────────────────────────────────────
create table if not exists invoices (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  subscription_id uuid references subscriptions(id) on delete set null,
  number      text unique,
  status      text not null default 'draft' check (status in ('draft','open','paid','void','uncollectible')),
  amount_cents integer not null default 0,
  tax_cents   integer not null default 0,
  total_cents integer not null default 0,
  currency    text not null default 'usd',
  period_start timestamptz,
  period_end  timestamptz,
  hosted_url  text,
  pdf_url     text,
  stripe_invoice_id text unique,
  line_items  jsonb not null default '[]'::jsonb,
  issued_at   timestamptz,
  paid_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists invoices_org_idx on invoices (org_id, created_at desc);

create table if not exists payments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  invoice_id  uuid references invoices(id) on delete set null,
  amount_cents integer not null default 0,
  currency    text not null default 'usd',
  status      text not null default 'pending' check (status in ('pending','succeeded','failed','refunded')),
  method      text,
  stripe_payment_intent_id text unique,
  failure_reason text,
  created_at  timestamptz not null default now()
);

create index if not exists payments_org_idx on payments (org_id, created_at desc);

-- Idempotency ledger for provider webhooks: an event is processed at most once.
create table if not exists webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  external_id  text not null,
  event_type   text not null,
  status       text not null default 'received' check (status in ('received','processed','failed','ignored')),
  payload      jsonb not null default '{}'::jsonb,
  error        text,
  processed_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (provider, external_id)
);

-- ─── background jobs ────────────────────────────────────────────────────────
create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  queue         text not null default 'default',
  kind          text not null,
  org_id        uuid references organizations(id) on delete cascade,
  project_id    uuid references projects(id) on delete cascade,
  task_id       uuid references tasks(id) on delete cascade,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                check (status in ('pending','running','completed','failed','cancelled')),
  priority      integer not null default 100,
  attempts      integer not null default 0,
  max_attempts  integer not null default 3,
  run_after     timestamptz not null default now(),
  locked_at     timestamptz,
  locked_by     text,
  error         text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists jobs_touch on jobs;
create trigger jobs_touch before update on jobs for each row execute function app.touch_updated_at();

create index if not exists jobs_claim_idx on jobs (status, run_after, priority) where status = 'pending';
create index if not exists jobs_project_idx on jobs (project_id, created_at desc);

-- Atomic claim: only one worker can ever take a given job.
create or replace function app.claim_job(p_queues text[], p_worker text, p_lock_seconds integer default 300)
returns setof jobs
language plpgsql security definer set search_path = public as $$
begin
  return query
  update jobs j set
    status = 'running',
    attempts = j.attempts + 1,
    locked_at = now(),
    locked_by = p_worker
  where j.id = (
    select id from jobs
    where status = 'pending' and run_after <= now() and queue = any(p_queues)
    order by priority asc, run_after asc
    for update skip locked
    limit 1
  )
  returning j.*;
end $$;

-- Recover jobs whose worker died mid-run.
create or replace function app.reap_stale_jobs(p_lock_seconds integer default 900)
returns integer
language sql security definer set search_path = public as $$
  with reaped as (
    update jobs set
      status = case when attempts >= max_attempts then 'failed' else 'pending' end,
      error = coalesce(error, 'Worker did not report back in time'),
      locked_at = null, locked_by = null
    where status = 'running' and locked_at < now() - make_interval(secs => p_lock_seconds)
    returning 1
  ) select count(*)::integer from reaped;
$$;

-- ─── system settings ────────────────────────────────────────────────────────
create table if not exists system_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  description text not null default '',
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

drop trigger if exists system_settings_touch on system_settings;
create trigger system_settings_touch before update on system_settings for each row execute function app.touch_updated_at();

-- ─── observability ──────────────────────────────────────────────────────────
create table if not exists system_events (
  id         bigserial primary key,
  kind       text not null,          -- 'api','model','tool','agent','db','queue'
  name       text not null,
  status     text not null default 'ok',
  duration_ms integer not null default 0,
  org_id     uuid,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists system_events_kind_time_idx on system_events (kind, created_at desc);
create index if not exists system_events_status_idx on system_events (status, created_at desc) where status <> 'ok';
