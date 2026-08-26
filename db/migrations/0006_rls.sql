-- ============================================================================
-- DiroxCode — 0006 Row Level Security
-- ============================================================================
-- Every table carrying tenant data is protected here. The service role bypasses
-- RLS by design and is used only for system writes and vetted admin routes.
--
-- Rule of thumb encoded below:
--   read   -> member of the owning organization (or the row's own user)
--   write  -> owner/admin/member of the owning organization
--   manage -> owner/admin only
--   platform admins can read everything; they mutate through the service role.

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','platform_admins','plans','organizations','organization_members','subscriptions',
    'projects','project_members','repositories','branches','files','code_symbols','file_dependencies',
    'project_memory','checkpoints','git_operations','conversations','messages','message_parts',
    'tasks','task_steps','tool_calls','tool_results','review_findings',
    'model_providers','models','model_routes','usage_records','usage_daily','ai_cache',
    'eval_suites','eval_runs','api_keys','user_sessions','audit_logs','notifications',
    'feature_flags','rate_limits','invoices','payments','webhook_events','jobs',
    'system_settings','system_events'
  ] loop
    execute format('alter table if exists %I enable row level security', t);
  end loop;
end $$;

-- Helper so every policy body stays short.
create or replace function app.reads_everything(uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_platform_admin(uid)
$$;

-- ─── identity ───────────────────────────────────────────────────────────────
drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles for select
  using (id = auth.uid() or app.reads_everything());

drop policy if exists profiles_self_write on profiles;
create policy profiles_self_write on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_self_insert on profiles;
create policy profiles_self_insert on profiles for insert
  with check (id = auth.uid());

drop policy if exists platform_admins_read on platform_admins;
create policy platform_admins_read on platform_admins for select
  using (user_id = auth.uid() or app.reads_everything());

-- ─── plans are public catalogue data ────────────────────────────────────────
drop policy if exists plans_read on plans;
create policy plans_read on plans for select using (is_public or app.reads_everything());

-- ─── organizations ──────────────────────────────────────────────────────────
-- The owner is included explicitly, not only through membership: when an
-- organization is first created its membership row does not exist yet, and
-- without this the creator could not read back the row they just inserted.
drop policy if exists organizations_read on organizations;
create policy organizations_read on organizations for select
  using (owner_id = auth.uid() or app.is_org_member(id) or app.reads_everything());

drop policy if exists organizations_insert on organizations;
create policy organizations_insert on organizations for insert
  with check (owner_id = auth.uid());

drop policy if exists organizations_update on organizations;
create policy organizations_update on organizations for update
  using (app.can_admin_org(id)) with check (app.can_admin_org(id));

drop policy if exists organizations_delete on organizations;
create policy organizations_delete on organizations for delete
  using (owner_id = auth.uid());

drop policy if exists org_members_read on organization_members;
create policy org_members_read on organization_members for select
  using (user_id = auth.uid() or app.is_org_member(org_id) or app.reads_everything());

drop policy if exists org_members_manage on organization_members;
create policy org_members_manage on organization_members for all
  using (app.can_admin_org(org_id)) with check (app.can_admin_org(org_id));

-- A new organization's first membership row is written by its creator.
--
-- The ownership check must be SECURITY DEFINER. An inline subquery against
-- organizations would itself be filtered by that table's read policy, which
-- depends on membership — the very row being inserted — and the two would
-- deadlock, leaving a new user unable to create their own workspace.
create or replace function app.owns_org(target_org uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations o where o.id = target_org and o.owner_id = uid)
$$;

drop policy if exists org_members_bootstrap on organization_members;
create policy org_members_bootstrap on organization_members for insert
  with check (user_id = auth.uid() and app.owns_org(org_id));

drop policy if exists subscriptions_read on subscriptions;
create policy subscriptions_read on subscriptions for select
  using (app.is_org_member(org_id) or app.reads_everything());

-- ─── projects ───────────────────────────────────────────────────────────────
-- Read from the row's own org_id rather than looking the project up by id:
-- INSERT ... RETURNING applies the SELECT policy while the row is still being
-- written, and a lookup by id finds nothing at that point.
drop policy if exists projects_read on projects;
create policy projects_read on projects for select
  using (
    org_id in (select org_id from organization_members where user_id = auth.uid())
    or exists (select 1 from project_members pm where pm.project_id = id and pm.user_id = auth.uid())
    or app.reads_everything()
  );

drop policy if exists projects_insert on projects;
create policy projects_insert on projects for insert
  with check (app.can_write_org(org_id));

drop policy if exists projects_update on projects;
create policy projects_update on projects for update
  using (app.can_write_org(org_id)) with check (app.can_write_org(org_id));

drop policy if exists projects_delete on projects;
create policy projects_delete on projects for delete
  using (app.can_admin_org(org_id));

drop policy if exists project_members_read on project_members;
create policy project_members_read on project_members for select
  using (user_id = auth.uid() or app.can_read_project(project_id) or app.reads_everything());

drop policy if exists project_members_manage on project_members;
create policy project_members_manage on project_members for all
  using (app.can_admin_org(app.project_org(project_id)))
  with check (app.can_admin_org(app.project_org(project_id)));

-- Project-scoped child tables all share the same shape.
do $$
declare t text;
begin
  foreach t in array array[
    'repositories','files','code_symbols','file_dependencies','checkpoints','git_operations','review_findings'
  ] loop
    execute format('drop policy if exists %1$s_read on %1$I', t);
    execute format(
      'create policy %1$s_read on %1$I for select using (app.can_read_project(project_id) or app.reads_everything())', t);
    execute format('drop policy if exists %1$s_write on %1$I', t);
    execute format(
      'create policy %1$s_write on %1$I for all using (app.can_write_project(project_id)) with check (app.can_write_project(project_id))', t);
  end loop;
end $$;

-- repositories.access_token_enc must never reach a browser. RLS cannot hide a
-- column, so the API selects an explicit safe column list and this view exists
-- for any direct PostgREST access.
create or replace view repositories_public
with (security_invoker = true) as
  select id, project_id, provider, external_id, owner, name, full_name, html_url,
         default_branch, visibility, last_synced_at, sync_error, created_at, updated_at
  from repositories;

drop policy if exists branches_read on branches;
create policy branches_read on branches for select
  using (exists (select 1 from repositories r where r.id = repository_id and app.can_read_project(r.project_id))
         or app.reads_everything());

drop policy if exists branches_write on branches;
create policy branches_write on branches for all
  using (exists (select 1 from repositories r where r.id = repository_id and app.can_write_project(r.project_id)))
  with check (exists (select 1 from repositories r where r.id = repository_id and app.can_write_project(r.project_id)));

drop policy if exists project_memory_read on project_memory;
create policy project_memory_read on project_memory for select
  using ((scope = 'user' and user_id = auth.uid())
      or (scope = 'project' and app.can_read_project(project_id))
      or app.reads_everything());

drop policy if exists project_memory_write on project_memory;
create policy project_memory_write on project_memory for all
  using ((scope = 'user' and user_id = auth.uid()) or (scope = 'project' and app.can_write_project(project_id)))
  with check ((scope = 'user' and user_id = auth.uid()) or (scope = 'project' and app.can_write_project(project_id)));

-- ─── conversations & tasks ──────────────────────────────────────────────────
drop policy if exists conversations_read on conversations;
create policy conversations_read on conversations for select
  using (user_id = auth.uid()
      or (project_id is not null and app.can_read_project(project_id))
      or app.reads_everything());

drop policy if exists conversations_write on conversations;
create policy conversations_write on conversations for all
  using (user_id = auth.uid() and app.is_org_member(org_id))
  with check (user_id = auth.uid() and app.is_org_member(org_id));

create or replace function app.can_read_conversation(target uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversations c
    where c.id = target
      and (c.user_id = uid or (c.project_id is not null and app.can_read_project(c.project_id, uid)))
  )
$$;

drop policy if exists messages_read on messages;
create policy messages_read on messages for select
  using (app.can_read_conversation(conversation_id) or app.reads_everything());

drop policy if exists messages_write on messages;
create policy messages_write on messages for all
  using (app.can_read_conversation(conversation_id)) with check (app.can_read_conversation(conversation_id));

drop policy if exists message_parts_read on message_parts;
create policy message_parts_read on message_parts for select
  using (exists (select 1 from messages m where m.id = message_id and app.can_read_conversation(m.conversation_id))
         or app.reads_everything());

drop policy if exists message_parts_write on message_parts;
create policy message_parts_write on message_parts for all
  using (exists (select 1 from messages m where m.id = message_id and app.can_read_conversation(m.conversation_id)))
  with check (exists (select 1 from messages m where m.id = message_id and app.can_read_conversation(m.conversation_id)));

drop policy if exists tasks_read on tasks;
create policy tasks_read on tasks for select
  using (user_id = auth.uid() or app.is_org_member(org_id) or app.reads_everything());

drop policy if exists tasks_write on tasks;
create policy tasks_write on tasks for all
  using (user_id = auth.uid() or app.can_admin_org(org_id))
  with check (app.is_org_member(org_id));

create or replace function app.can_read_task(target uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasks t where t.id = target and (t.user_id = uid or app.is_org_member(t.org_id, uid)))
$$;

do $$
declare t text;
begin
  foreach t in array array['task_steps','tool_calls'] loop
    execute format('drop policy if exists %1$s_read on %1$I', t);
    execute format('create policy %1$s_read on %1$I for select using (app.can_read_task(task_id) or app.reads_everything())', t);
    execute format('drop policy if exists %1$s_write on %1$I', t);
    execute format('create policy %1$s_write on %1$I for all using (app.can_read_task(task_id)) with check (app.can_read_task(task_id))', t);
  end loop;
end $$;

drop policy if exists tool_results_read on tool_results;
create policy tool_results_read on tool_results for select
  using (exists (select 1 from tool_calls tc where tc.id = tool_call_id and app.can_read_task(tc.task_id))
         or app.reads_everything());

-- ─── AI configuration: readable by signed-in users, writable by admins only ──
drop policy if exists models_read on models;
create policy models_read on models for select using (auth.uid() is not null);

drop policy if exists model_routes_read on model_routes;
create policy model_routes_read on model_routes for select using (auth.uid() is not null);

-- model_providers holds key material references; only platform admins may read.
drop policy if exists model_providers_read on model_providers;
create policy model_providers_read on model_providers for select using (app.reads_everything());

drop policy if exists eval_suites_read on eval_suites;
create policy eval_suites_read on eval_suites for select using (app.reads_everything());
drop policy if exists eval_runs_read on eval_runs;
create policy eval_runs_read on eval_runs for select using (app.reads_everything());

-- ─── usage, cost, cache ─────────────────────────────────────────────────────
drop policy if exists usage_records_read on usage_records;
create policy usage_records_read on usage_records for select
  using (user_id = auth.uid() or (org_id is not null and app.can_admin_org(org_id)) or app.reads_everything());

drop policy if exists usage_daily_read on usage_daily;
create policy usage_daily_read on usage_daily for select
  using ((org_id is not null and app.can_admin_org(org_id)) or app.reads_everything());

-- ai_cache is written and read by the server only; no client policy is granted.

-- ─── platform surfaces ──────────────────────────────────────────────────────
drop policy if exists api_keys_read on api_keys;
create policy api_keys_read on api_keys for select
  using (user_id = auth.uid() or app.can_admin_org(org_id) or app.reads_everything());

drop policy if exists api_keys_write on api_keys;
create policy api_keys_write on api_keys for all
  using (user_id = auth.uid() or app.can_admin_org(org_id))
  with check (user_id = auth.uid() and app.is_org_member(org_id));

drop policy if exists user_sessions_read on user_sessions;
create policy user_sessions_read on user_sessions for select
  using (user_id = auth.uid() or app.reads_everything());

drop policy if exists user_sessions_write on user_sessions;
create policy user_sessions_write on user_sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists audit_logs_read on audit_logs;
create policy audit_logs_read on audit_logs for select
  using (actor_id = auth.uid() or (org_id is not null and app.can_admin_org(org_id)) or app.reads_everything());

drop policy if exists notifications_read on notifications;
create policy notifications_read on notifications for select using (user_id = auth.uid());

drop policy if exists notifications_update on notifications;
create policy notifications_update on notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists feature_flags_read on feature_flags;
create policy feature_flags_read on feature_flags for select using (auth.uid() is not null);

drop policy if exists invoices_read on invoices;
create policy invoices_read on invoices for select
  using (app.can_admin_org(org_id) or app.reads_everything());

drop policy if exists payments_read on payments;
create policy payments_read on payments for select
  using (app.can_admin_org(org_id) or app.reads_everything());

drop policy if exists jobs_read on jobs;
create policy jobs_read on jobs for select
  using ((project_id is not null and app.can_read_project(project_id))
      or (org_id is not null and app.is_org_member(org_id))
      or app.reads_everything());

drop policy if exists system_settings_read on system_settings;
create policy system_settings_read on system_settings for select using (app.reads_everything());

drop policy if exists system_events_read on system_events;
create policy system_events_read on system_events for select using (app.reads_everything());

-- rate_limits, webhook_events and ai_cache intentionally have no client
-- policies: they are service-role only.
