-- ============================================================================
-- DiroxCode — 0004 ai: providers, models, routing, usage and cost
-- ============================================================================
-- The application never hardcodes a provider or a price. Everything an admin
-- can change at runtime lives in these tables.

create table if not exists model_providers (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  name         text not null,
  -- how the wire format is spoken, not who sells it
  adapter      text not null default 'openai'
               check (adapter in ('openai','anthropic','google','openrouter')),
  base_url     text not null,
  -- name of the environment variable holding the key, e.g. OPENROUTER_API_KEY.
  -- Preferred over api_key_enc: keys stay in Railway, not in the database.
  key_ref      text,
  api_key_enc  text,
  default_headers jsonb not null default '{}'::jsonb,
  enabled      boolean not null default true,
  priority     integer not null default 100,
  timeout_ms   integer not null default 120000,
  max_retries  integer not null default 2,
  requests_per_minute integer not null default 300,
  health_status text not null default 'unknown' check (health_status in ('unknown','healthy','degraded','down')),
  health_checked_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists model_providers_touch on model_providers;
create trigger model_providers_touch before update on model_providers for each row execute function app.touch_updated_at();

create table if not exists models (
  id            uuid primary key default gen_random_uuid(),
  provider_id   uuid not null references model_providers(id) on delete cascade,
  code          text not null,            -- provider-side model id
  name          text not null,            -- display name
  description   text not null default '',
  -- prices are per million tokens, in micro-USD, so integer math stays exact
  input_price_micros  bigint not null default 0,
  output_price_micros bigint not null default 0,
  cached_input_price_micros bigint,
  context_window integer not null default 128000,
  max_output     integer not null default 8192,
  supports_reasoning boolean not null default false,
  supports_vision    boolean not null default false,
  supports_tools     boolean not null default true,
  supports_structured_output boolean not null default true,
  supports_prompt_cache      boolean not null default false,
  -- which routing levels this model may serve
  tiers         text[] not null default '{level1,level2}',
  enabled       boolean not null default true,
  priority      integer not null default 100,
  fallback_model_id uuid references models(id) on delete set null,
  requests_per_minute integer not null default 120,
  tokens_per_minute   integer not null default 200000,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (provider_id, code)
);

drop trigger if exists models_touch on models;
create trigger models_touch before update on models for each row execute function app.touch_updated_at();

create index if not exists models_enabled_idx on models (enabled, priority);
create index if not exists models_tiers_idx on models using gin (tiers);

-- Routing rules: task category + complexity level -> model, editable live.
create table if not exists model_routes (
  id          uuid primary key default gen_random_uuid(),
  category    text not null
              check (category in ('chat','classify','plan','code','debug','review','architecture','summarize','embed','title')),
  level       text not null check (level in ('level0','level1','level2','level3','level4')),
  model_id    uuid not null references models(id) on delete cascade,
  fallback_model_id uuid references models(id) on delete set null,
  max_input_tokens  integer,
  max_output_tokens integer,
  temperature real not null default 0.2,
  reasoning_effort text check (reasoning_effort in ('none','low','medium','high')),
  enabled     boolean not null default true,
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (category, level)
);

drop trigger if exists model_routes_touch on model_routes;
create trigger model_routes_touch before update on model_routes for each row execute function app.touch_updated_at();

-- ─── usage & cost ───────────────────────────────────────────────────────────
-- One row per model call. This is the single source of truth for both the
-- user-facing cost display and the admin margin analytics.
create table if not exists usage_records (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references organizations(id) on delete set null,
  user_id       uuid references auth.users(id) on delete set null,
  project_id    uuid references projects(id) on delete set null,
  task_id       uuid references tasks(id) on delete set null,
  model_id      uuid references models(id) on delete set null,
  provider_code text,
  model_code    text,
  category      text,
  level         text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  total_tokens  integer generated always as (input_tokens + output_tokens) stored,
  cost_micros   bigint not null default 0,
  latency_ms    integer not null default 0,
  cache_hit     boolean not null default false,
  fallback_used boolean not null default false,
  escalated_from text,
  status        text not null default 'ok' check (status in ('ok','error','timeout','cancelled')),
  error_code    text,
  created_at    timestamptz not null default now()
);

create index if not exists usage_records_org_time_idx on usage_records (org_id, created_at desc);
create index if not exists usage_records_user_time_idx on usage_records (user_id, created_at desc);
create index if not exists usage_records_task_idx on usage_records (task_id);
create index if not exists usage_records_model_time_idx on usage_records (model_id, created_at desc);

-- Pre-aggregated daily rollups keep dashboards off the raw table.
create table if not exists usage_daily (
  day           date not null,
  org_id        uuid references organizations(id) on delete cascade,
  model_id      uuid references models(id) on delete set null,
  requests      integer not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  cost_micros   bigint not null default 0,
  errors        integer not null default 0,
  primary key (day, org_id, model_id)
);

create index if not exists usage_daily_day_idx on usage_daily (day desc);

-- Aggregate a usage record into the daily rollup atomically.
create or replace function app.record_usage_daily(
  p_day date, p_org uuid, p_model uuid,
  p_input bigint, p_output bigint, p_cached bigint, p_cost bigint, p_error boolean
) returns void
language sql security definer set search_path = public as $$
  insert into usage_daily (day, org_id, model_id, requests, input_tokens, output_tokens, cached_tokens, cost_micros, errors)
  values (p_day, p_org, p_model, 1, p_input, p_output, p_cached, p_cost, case when p_error then 1 else 0 end)
  on conflict (day, org_id, model_id) do update set
    requests      = usage_daily.requests + 1,
    input_tokens  = usage_daily.input_tokens + excluded.input_tokens,
    output_tokens = usage_daily.output_tokens + excluded.output_tokens,
    cached_tokens = usage_daily.cached_tokens + excluded.cached_tokens,
    cost_micros   = usage_daily.cost_micros + excluded.cost_micros,
    errors        = usage_daily.errors + excluded.errors;
$$;

-- Current billing-period consumption for one organization, in one round trip.
create or replace function app.org_period_usage(p_org uuid, p_since timestamptz)
returns table (requests bigint, input_tokens bigint, output_tokens bigint, cost_micros bigint, tasks bigint)
language sql stable security definer set search_path = public as $$
  select
    count(*)::bigint,
    coalesce(sum(u.input_tokens),0)::bigint,
    coalesce(sum(u.output_tokens),0)::bigint,
    coalesce(sum(u.cost_micros),0)::bigint,
    (select count(*) from tasks t where t.org_id = p_org and t.created_at >= p_since)::bigint
  from usage_records u
  where u.org_id = p_org and u.created_at >= p_since;
$$;

-- ─── AI response cache ──────────────────────────────────────────────────────
-- Only ever read back within the same organization: tenant isolation is part
-- of the primary key, not a filter that could be forgotten.
create table if not exists ai_cache (
  cache_key   text not null,
  org_id      uuid not null references organizations(id) on delete cascade,
  model_code  text not null,
  category    text not null default 'chat',
  response    jsonb not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  hit_count   integer not null default 0,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now(),
  primary key (org_id, cache_key)
);

create index if not exists ai_cache_expiry_idx on ai_cache (expires_at);

-- ─── evaluation harness ─────────────────────────────────────────────────────
create table if not exists eval_suites (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  name       text not null,
  description text not null default '',
  cases      jsonb not null default '[]'::jsonb,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists eval_runs (
  id          uuid primary key default gen_random_uuid(),
  suite_id    uuid not null references eval_suites(id) on delete cascade,
  model_id    uuid references models(id) on delete set null,
  status      text not null default 'running' check (status in ('running','completed','failed')),
  passed      integer not null default 0,
  failed      integer not null default 0,
  total       integer not null default 0,
  avg_tokens  integer not null default 0,
  avg_cost_micros bigint not null default 0,
  avg_latency_ms integer not null default 0,
  retries     integer not null default 0,
  results     jsonb not null default '[]'::jsonb,
  started_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists eval_runs_suite_idx on eval_runs (suite_id, created_at desc);
