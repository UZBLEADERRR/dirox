-- ============================================================================
-- DiroxCode — 0009 fix: a new user must be able to create their workspace
-- ============================================================================
-- Found by running the migrations against a real Postgres and signing in.
--
-- Two policies deadlocked on first sign-in:
--
--   organizations_read      required membership
--   org_members_bootstrap   required reading the organization
--
-- The membership row is inserted after the organization, so the creator could
-- neither read back the organization they had just created nor insert the
-- membership row that would have let them. A brand new account could not be
-- set up at all.
--
-- This migration is included separately so an installation that already ran
-- 0006 converges on the same corrected policies. 0006 itself now creates them
-- correctly for a fresh install, and both paths end in the same state.

create or replace function app.owns_org(target_org uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from organizations o where o.id = target_org and o.owner_id = uid)
$$;

drop policy if exists organizations_read on organizations;
create policy organizations_read on organizations for select
  using (owner_id = auth.uid() or app.is_org_member(id) or app.reads_everything());

drop policy if exists org_members_bootstrap on organization_members;
create policy org_members_bootstrap on organization_members for insert
  with check (user_id = auth.uid() and app.owns_org(org_id));
