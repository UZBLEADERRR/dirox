-- ─────────────────────────────────────────────────────────────────────────────
-- Uploads: files a person sends in
--
-- The other direction from `deliverables`. A logo, a screenshot, a design, a
-- CSV — something the user has and the agent needs. Images were previously
-- dropped on the floor with a note saying they were not passed to the model,
-- which meant "add this logo to the repo" was unanswerable.
--
-- As with deliverables, the row is the record and object storage holds the
-- bytes. Unlike deliverables, an upload starts outside any workspace: it is
-- placed into one on request, at a path the agent chooses.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists uploads (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  project_id   uuid references projects(id) on delete set null,
  task_id      uuid,

  name         text not null,
  content_type text not null default 'application/octet-stream',
  size_bytes   bigint not null default 0,
  sha256       text,

  -- Where the bytes live, and which bucket holds them. An avatar is public;
  -- everything else is not.
  storage_key  text not null,
  bucket       text not null default 'project-files',
  purpose      text not null default 'attachment'
               check (purpose in ('attachment','avatar','asset')),

  -- Set once the agent copies it into a workspace, so a second run knows the
  -- file already has a home.
  placed_path  text,
  created_at   timestamptz not null default now()
);

create index if not exists uploads_task_idx on uploads (task_id, created_at desc);
create index if not exists uploads_org_idx on uploads (org_id, created_at desc);
create index if not exists uploads_project_idx on uploads (project_id, created_at desc);

comment on table uploads is
  'A file the user sent in. The bytes are in object storage; this row records what it is and where it went.';

alter table uploads enable row level security;

drop policy if exists uploads_read on uploads;
create policy uploads_read on uploads for select
  using (app.is_org_member(org_id) or app.reads_everything());

drop policy if exists uploads_delete on uploads;
create policy uploads_delete on uploads for delete
  using (app.can_write_org(org_id));

-- PostgREST caches the schema; ask it to reload so the new table resolves.
do $$
begin
  notify pgrst, 'reload schema';
exception when others then
  null;
end $$;
