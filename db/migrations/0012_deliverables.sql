-- ─────────────────────────────────────────────────────────────────────────────
-- Deliverables: files the agent hands back to a person
--
-- The agent could build a zip, a report or a compiled binary and then had no
-- way to give it to anyone — everything it produced stayed inside the
-- workspace, reachable only by another tool call. This is the handover.
--
-- A row is a permission to download one file, not a copy of it: the bytes stay
-- in the project workspace and are streamed on request. That keeps large
-- artefacts out of the database, and means a deliverable cannot outlive the
-- workspace it describes.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists deliverables (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  project_id    uuid references projects(id) on delete cascade,
  task_id       uuid,
  user_id       uuid references auth.users(id) on delete set null,

  -- Path inside the project workspace. Re-validated on every download rather
  -- than trusted from here: a row is not a capability to read arbitrary files.
  path          text not null,
  name          text not null,
  content_type  text not null default 'application/octet-stream',
  size_bytes    bigint not null default 0,
  sha256        text,

  label         text,
  download_count integer not null default 0,
  last_download_at timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists deliverables_task_idx on deliverables (task_id, created_at desc);
create index if not exists deliverables_org_idx on deliverables (org_id, created_at desc);
create index if not exists deliverables_project_idx on deliverables (project_id, created_at desc);

comment on table deliverables is
  'A file the agent produced and offered to the user. The bytes live in the workspace; this row records the offer.';

alter table deliverables enable row level security;

-- Readable by anyone in the organization; written only by the system, which
-- is the only thing that can vouch that the path is inside the workspace.
drop policy if exists deliverables_read on deliverables;
create policy deliverables_read on deliverables for select
  using (app.is_org_member(org_id) or app.reads_everything());

drop policy if exists deliverables_delete on deliverables;
create policy deliverables_delete on deliverables for delete
  using (app.can_write_org(org_id));

-- PostgREST caches the schema; ask it to reload so the new table resolves.
do $$
begin
  notify pgrst, 'reload schema';
exception when others then
  null;
end $$;
