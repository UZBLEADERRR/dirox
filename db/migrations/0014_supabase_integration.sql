-- ─────────────────────────────────────────────────────────────────────────────
-- Connecting the user's own Supabase project
--
-- The agent can write an application; it could not give that application a
-- database. Asking a person to paste SQL into a dashboard between every
-- iteration is not automation, it is the part of the work we failed to do.
--
-- Stored beside the GitHub connection, because it is the same kind of thing: a
-- credential the user grants once, held encrypted, used on their behalf.
-- `metadata` carries the parts that are not secret — the project URL, the
-- reference — so listing a connection never has to decrypt anything.
-- ─────────────────────────────────────────────────────────────────────────────

alter table user_integrations drop constraint if exists user_integrations_provider_check;
alter table user_integrations add constraint user_integrations_provider_check
  check (provider in ('github', 'gitlab', 'supabase'));

alter table user_integrations add column if not exists metadata jsonb not null default '{}'::jsonb;

-- A second encrypted slot. GitHub needs one credential; a Supabase project has
-- an API key and, separately, a database connection string, and the agent
-- needs whichever the task calls for.
alter table user_integrations add column if not exists secondary_token_enc text;

comment on column user_integrations.metadata is
  'Non-secret connection details — project URL, reference, host. Never a key.';
comment on column user_integrations.secondary_token_enc is
  'A second credential for providers that have one, such as a database connection string.';

-- PostgREST caches the schema; ask it to reload so the new columns resolve.
do $$
begin
  notify pgrst, 'reload schema';
exception when others then
  null;
end $$;
