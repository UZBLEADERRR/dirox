-- ============================================================================
-- DiroxCode — 0008 integrations: per-user connected accounts
-- ============================================================================
-- A user connects GitHub once; the token is stored encrypted here and reused
-- for every repository they import. Storing it on the repository row instead
-- would duplicate the secret and orphan it when a project is deleted.

create table if not exists user_integrations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  provider     text not null check (provider in ('github','gitlab')),
  external_id  text,
  account_login text,
  account_name text,
  avatar_url   text,
  scopes       text[] not null default '{}',
  -- encrypted with DIROX_ENCRYPTION_KEY; never selected by client-facing code
  access_token_enc  text not null,
  refresh_token_enc text,
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, provider)
);

drop trigger if exists user_integrations_touch on user_integrations;
create trigger user_integrations_touch before update on user_integrations
  for each row execute function app.touch_updated_at();

alter table user_integrations enable row level security;

-- Deliberately no client policy on the token columns: the browser has no
-- reason to read this table at all. The API returns a safe projection instead.
create or replace view user_integrations_public
with (security_invoker = true) as
  select id, user_id, provider, account_login, account_name, avatar_url,
         scopes, expires_at, last_used_at, revoked_at, created_at
  from user_integrations;

drop policy if exists user_integrations_self on user_integrations;
create policy user_integrations_self on user_integrations for select
  using (user_id = auth.uid());

drop policy if exists user_integrations_delete on user_integrations;
create policy user_integrations_delete on user_integrations for delete
  using (user_id = auth.uid());
