#!/usr/bin/env bash
#
# Apply every migration to a throwaway Postgres and assert the schema is what
# the application expects.
#
# Supabase supplies auth.users and auth.uid(); this script shims both so the
# migrations can be exercised without a Supabase project.
#
# Usage: scripts/verify-migrations.sh [psql-connection-args]
#   e.g. scripts/verify-migrations.sh -h /tmp -p 54329 -U postgres

set -uo pipefail

PG=("$@")
[ ${#PG[@]} -eq 0 ] && PG=(-h localhost -U postgres)

run() { psql "${PG[@]}" -v ON_ERROR_STOP=1 -q "$@"; }

echo "── resetting the target database ──"
run -c "drop schema if exists public cascade; create schema public;
        drop schema if exists app cascade; drop schema if exists auth cascade;" >/dev/null || exit 1

run <<'SQL' >/dev/null || exit 1
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
SQL

echo "── applying migrations ──"
failed=0
for file in db/migrations/*.sql; do
  if output=$(run -f "$file" 2>&1); then
    echo "  ✓ $(basename "$file")"
  else
    failed=1
    echo "  ✗ $(basename "$file")"
    echo "$output" | grep -v NOTICE | head -10 | sed 's/^/      /'
  fi
done
[ $failed -eq 1 ] && { echo "── migrations FAILED ──"; exit 1; }

echo "── verifying the resulting schema ──"
run <<'SQL' || exit 1
do $$
declare
  missing text[] := '{}';
  t text;
  expected_tables text[] := array[
    'profiles','platform_admins','plans','organizations','organization_members',
    'subscriptions','projects','project_members','repositories','branches','files',
    'code_symbols','file_dependencies','project_memory','checkpoints','git_operations',
    'conversations','messages','message_parts','tasks','task_steps','tool_calls',
    'tool_results','review_findings','model_providers','models','model_routes',
    'usage_records','usage_daily','ai_cache','eval_suites','eval_runs','api_keys',
    'user_sessions','audit_logs','notifications','feature_flags','rate_limits',
    'invoices','payments','webhook_events','jobs','system_settings','system_events',
    'user_integrations'
  ];
begin
  foreach t in array expected_tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema='public' and table_name=t) then
      missing := missing || t;
    end if;
  end loop;
  if array_length(missing,1) > 0 then
    raise exception 'missing tables: %', array_to_string(missing, ', ');
  end if;
  raise notice 'all % expected tables exist', array_length(expected_tables,1);
end $$;

-- Every tenant table must actually have RLS enabled, not merely policies written.
do $$
declare
  unprotected text[];
begin
  select array_agg(c.relname order by c.relname) into unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if unprotected is not null then
    raise exception 'RLS not enabled on: %', array_to_string(unprotected, ', ');
  end if;
  raise notice 'row level security is enabled on every table';
end $$;

-- The predicate functions the policies depend on must exist and be callable.
do $$
declare fn text;
begin
  foreach fn in array array[
    'is_platform_admin','is_org_member','org_role','can_admin_org','can_write_org',
    'project_org','can_read_project','can_write_project','can_read_conversation',
    'can_read_task','reads_everything','claim_job','reap_stale_jobs',
    'record_usage_daily','org_period_usage','bump_rate_limit','touch_updated_at',
    'handle_new_user','current_user_id'
  ] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname='app' and p.proname=fn) then
      raise exception 'missing function app.%', fn;
    end if;
  end loop;
  raise notice 'all predicate and helper functions exist';
end $$;

-- Seed data must be present, or routing has nothing to route to.
do $$
declare plan_count int; provider_count int; model_count int; route_count int; flag_count int;
begin
  select count(*) into plan_count from plans;
  select count(*) into provider_count from model_providers;
  select count(*) into model_count from models;
  select count(*) into route_count from model_routes;
  select count(*) into flag_count from feature_flags;

  if plan_count = 0 then raise exception 'no plans seeded'; end if;
  if provider_count = 0 then raise exception 'no providers seeded'; end if;
  if model_count = 0 then raise exception 'no models seeded'; end if;
  if route_count = 0 then raise exception 'no routing rules seeded'; end if;

  raise notice 'seeded: % plans, % providers, % models, % routes, % flags',
    plan_count, provider_count, model_count, route_count, flag_count;
end $$;

-- Exactly one default plan, or new signups are ambiguous.
do $$
declare n int;
begin
  select count(*) into n from plans where is_default;
  if n <> 1 then raise exception 'expected exactly one default plan, found %', n; end if;
  raise notice 'exactly one default plan';
end $$;

-- Every routing rule must point at a model that exists and is enabled.
do $$
declare broken int;
begin
  select count(*) into broken from model_routes r
  left join models m on m.id = r.model_id
  where m.id is null or not m.enabled;
  if broken > 0 then raise exception '% routing rules point at a missing or disabled model', broken; end if;
  raise notice 'every routing rule resolves to an enabled model';
end $$;

-- No model may be its own fallback, which would loop.
do $$
declare n int;
begin
  select count(*) into n from models where fallback_model_id = id;
  if n > 0 then raise exception '% models are their own fallback', n; end if;
  raise notice 'no self-referential fallbacks';
end $$;
SQL

echo "── re-applying every migration to prove idempotency ──"
for file in db/migrations/*.sql; do
  if output=$(run -f "$file" 2>&1); then
    echo "  ✓ $(basename "$file") (second run)"
  else
    echo "  ✗ $(basename "$file") is not idempotent"
    echo "$output" | grep -v NOTICE | head -10 | sed 's/^/      /'
    exit 1
  fi
done

echo "── schema verified ──"
