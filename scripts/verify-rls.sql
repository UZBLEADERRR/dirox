-- ============================================================================
-- Tenant isolation proof.
--
-- Creates two users in two organizations and asserts, as each of them, that
-- Row Level Security actually prevents cross-tenant reads and writes.
--
-- Run after scripts/verify-migrations.sh against the same database.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- ── fixtures, created as the table owner so RLS does not block setup ────────
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'mallory@example.com')
on conflict (id) do nothing;

insert into organizations (id, slug, name, owner_id, is_personal) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice-org', 'Alice Org',
   '11111111-1111-1111-1111-111111111111', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'mallory-org', 'Mallory Org',
   '22222222-2222-2222-2222-222222222222', true);

insert into organization_members (org_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner');

insert into projects (id, org_id, created_by, name, slug) values
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 'Alice Secret Project', 'alice-secret');

insert into tasks (id, org_id, project_id, user_id, title, objective) values
  ('dddddddd-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'Alice private task', 'do the secret thing');

insert into files (project_id, path, content_hash) values
  ('cccccccc-0000-0000-0000-000000000003', 'src/secret.ts', 'deadbeef');

insert into project_memory (project_id, scope, kind, content) values
  ('cccccccc-0000-0000-0000-000000000003', 'project', 'note', 'Alice architecture note');

-- RLS applies to a role that does not own the tables; `postgres` bypasses it.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'rls_test') then
    create role rls_test nologin;
  end if;
end $$;
grant usage on schema public, app to rls_test;
grant select, insert, update, delete on all tables in schema public to rls_test;
grant execute on all functions in schema app to rls_test;

-- ── as Mallory: none of Alice's data may be visible ────────────────────────
set local role rls_test;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare n int;
begin
  select count(*) into n from projects where id = 'cccccccc-0000-0000-0000-000000000003';
  if n <> 0 then raise exception 'LEAK: Mallory can see Alice''s project'; end if;

  select count(*) into n from tasks where id = 'dddddddd-0000-0000-0000-000000000004';
  if n <> 0 then raise exception 'LEAK: Mallory can see Alice''s task'; end if;

  select count(*) into n from files where project_id = 'cccccccc-0000-0000-0000-000000000003';
  if n <> 0 then raise exception 'LEAK: Mallory can see Alice''s files'; end if;

  select count(*) into n from project_memory where project_id = 'cccccccc-0000-0000-0000-000000000003';
  if n <> 0 then raise exception 'LEAK: Mallory can see Alice''s project memory'; end if;

  select count(*) into n from organizations where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'LEAK: Mallory can see Alice''s organization'; end if;

  select count(*) into n from profiles where id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then raise exception 'LEAK: Mallory can read Alice''s profile'; end if;

  raise notice 'PASS: Mallory sees none of Alice''s projects, tasks, files, memory, org or profile';
end $$;

-- Mallory must not be able to write into Alice's project either.
do $$
begin
  begin
    insert into files (project_id, path, content_hash)
    values ('cccccccc-0000-0000-0000-000000000003', 'src/injected.ts', 'cafe');
    raise exception 'LEAK: Mallory inserted a file into Alice''s project';
  exception
    when insufficient_privilege or check_violation then
      raise notice 'PASS: Mallory cannot insert into Alice''s project';
  end;

  begin
    update projects set name = 'pwned' where id = 'cccccccc-0000-0000-0000-000000000003';
    if found then raise exception 'LEAK: Mallory renamed Alice''s project'; end if;
    raise notice 'PASS: Mallory cannot update Alice''s project';
  exception
    when insufficient_privilege then
      raise notice 'PASS: Mallory cannot update Alice''s project';
  end;

  begin
    delete from tasks where id = 'dddddddd-0000-0000-0000-000000000004';
    if found then raise exception 'LEAK: Mallory deleted Alice''s task'; end if;
    raise notice 'PASS: Mallory cannot delete Alice''s task';
  exception
    when insufficient_privilege then
      raise notice 'PASS: Mallory cannot delete Alice''s task';
  end;

  -- Joining an organization must not be self-service.
  begin
    insert into organization_members (org_id, user_id, role)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'admin');
    raise exception 'LEAK: Mallory added themselves to Alice''s organization';
  exception
    when insufficient_privilege or check_violation then
      raise notice 'PASS: Mallory cannot join Alice''s organization';
  end;
end $$;

-- ── as Alice: her own data must still be reachable ─────────────────────────
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare n int;
begin
  select count(*) into n from projects where id = 'cccccccc-0000-0000-0000-000000000003';
  if n <> 1 then raise exception 'BROKEN: Alice cannot see her own project'; end if;

  select count(*) into n from tasks where id = 'dddddddd-0000-0000-0000-000000000004';
  if n <> 1 then raise exception 'BROKEN: Alice cannot see her own task'; end if;

  select count(*) into n from files where project_id = 'cccccccc-0000-0000-0000-000000000003';
  if n <> 1 then raise exception 'BROKEN: Alice cannot see her own files'; end if;

  select count(*) into n from profiles where id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then raise exception 'BROKEN: Alice cannot read her own profile'; end if;

  raise notice 'PASS: Alice can read her own project, task, files and profile';
end $$;

-- ── provider secrets are not readable by an ordinary signed-in user ────────
do $$
declare n int;
begin
  select count(*) into n from model_providers;
  if n <> 0 then raise exception 'LEAK: a non-admin user can read model_providers'; end if;
  raise notice 'PASS: provider rows are invisible to non-admin users';

  -- But the model catalogue itself must be readable, or routing cannot work.
  select count(*) into n from models;
  if n = 0 then raise exception 'BROKEN: a signed-in user cannot read the model catalogue'; end if;
  raise notice 'PASS: the model catalogue is readable by signed-in users';
end $$;

-- ── an anonymous caller sees nothing ───────────────────────────────────────
set local request.jwt.claim.sub = '';

do $$
declare n int;
begin
  select count(*) into n from projects;
  if n <> 0 then raise exception 'LEAK: anonymous access returned % projects', n; end if;

  select count(*) into n from tasks;
  if n <> 0 then raise exception 'LEAK: anonymous access returned % tasks', n; end if;

  select count(*) into n from models;
  if n <> 0 then raise exception 'LEAK: anonymous access returned the model catalogue'; end if;

  -- Public plans are the one thing an anonymous caller may read, for pricing.
  select count(*) into n from plans where is_public;
  if n = 0 then raise exception 'BROKEN: anonymous callers cannot read public pricing'; end if;

  raise notice 'PASS: anonymous callers see only public plans';
end $$;

reset role;
rollback;

\echo '── tenant isolation verified ──'
