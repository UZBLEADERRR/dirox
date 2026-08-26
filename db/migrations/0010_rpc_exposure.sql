-- ============================================================================
-- DiroxCode — 0010 fix: expose the RPC functions PostgREST can actually reach
-- ============================================================================
-- Found by running the application against a real PostgREST.
--
-- The helper functions were defined in schema `app`, which is correct for the
-- predicates that RLS policies call directly. But five of them are invoked by
-- the application over HTTP as `/rest/v1/rpc/<name>`, and PostgREST only
-- exposes the schemas listed in `db-schemas` — `public` on Supabase. Every one
-- of those calls returned PGRST202, which broke the job queue outright and made
-- plan-limit checks fail on any request that consulted usage.
--
-- The predicates stay in `app`, where they belong. These five get thin `public`
-- wrappers so they are reachable, with the same SECURITY DEFINER semantics.

-- Claim one job atomically. Used by every worker.
create or replace function public.claim_job(p_queues text[], p_worker text, p_lock_seconds integer default 300)
returns setof jobs
language sql security definer set search_path = public as $$
  select * from app.claim_job(p_queues, p_worker, p_lock_seconds)
$$;

-- Recover jobs whose worker died mid-run.
create or replace function public.reap_stale_jobs(p_lock_seconds integer default 900)
returns integer
language sql security definer set search_path = public as $$
  select app.reap_stale_jobs(p_lock_seconds)
$$;

-- Aggregate one usage record into the daily rollup.
create or replace function public.record_usage_daily(
  p_day date, p_org uuid, p_model uuid,
  p_input bigint, p_output bigint, p_cached bigint, p_cost bigint, p_error boolean
) returns void
language sql security definer set search_path = public as $$
  select app.record_usage_daily(p_day, p_org, p_model, p_input, p_output, p_cached, p_cost, p_error)
$$;

-- Current billing-period consumption for one organization.
create or replace function public.org_period_usage(p_org uuid, p_since timestamptz)
returns table (requests bigint, input_tokens bigint, output_tokens bigint, cost_micros bigint, tasks bigint)
language sql stable security definer set search_path = public as $$
  select * from app.org_period_usage(p_org, p_since)
$$;

-- Durable quota counter.
create or replace function public.bump_rate_limit(
  p_scope text, p_scope_id text, p_bucket text, p_window timestamptz, p_amount bigint
) returns bigint
language sql security definer set search_path = public as $$
  select app.bump_rate_limit(p_scope, p_scope_id, p_bucket, p_window, p_amount)
$$;

-- These are system operations. Only the service role may call them; an
-- ordinary signed-in user has no business claiming jobs or writing rollups.
revoke execute on function
  public.claim_job(text[], text, integer),
  public.reap_stale_jobs(integer),
  public.record_usage_daily(date, uuid, uuid, bigint, bigint, bigint, bigint, boolean),
  public.bump_rate_limit(text, text, text, timestamptz, bigint)
from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function
      public.claim_job(text[], text, integer),
      public.reap_stale_jobs(integer),
      public.record_usage_daily(date, uuid, uuid, bigint, bigint, bigint, bigint, boolean),
      public.org_period_usage(uuid, timestamptz),
      public.bump_rate_limit(text, text, text, timestamptz, bigint)
      to service_role';
  end if;
end $$;

-- PostgREST caches the schema; tell it to reload so the new functions resolve.
notify pgrst, 'reload schema';

-- ─── projects: read and write from the row's own column ─────────────────────
-- `projects_read` resolved the organization by looking the project up by id,
-- which cannot work while the row is still being inserted: INSERT … RETURNING
-- applies the SELECT policy, and the lookup finds nothing. Reading `org_id`
-- straight off the row under evaluation is both correct and one query cheaper.

drop policy if exists projects_read on projects;
create policy projects_read on projects for select
  using (
    org_id in (select org_id from organization_members where user_id = auth.uid())
    or exists (select 1 from project_members pm where pm.project_id = id and pm.user_id = auth.uid())
    or app.reads_everything()
  );

drop policy if exists projects_update on projects;
create policy projects_update on projects for update
  using (app.can_write_org(org_id)) with check (app.can_write_org(org_id));
