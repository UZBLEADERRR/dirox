-- ============================================================================
-- DiroxCode — 0002 projects: repositories, index, memory, checkpoints
-- ============================================================================

create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  created_by    uuid references auth.users(id) on delete set null,
  name          text not null,
  slug          text not null,
  description   text not null default '',
  -- detected by the code-intelligence pass, never guessed by the UI
  language      text,
  framework     text,
  package_manager text,
  test_command  text,
  build_command text,
  dev_command   text,
  root_path     text not null default '',
  status        text not null default 'created'
                check (status in ('created','indexing','ready','error','archived')),
  index_status  text not null default 'pending'
                check (index_status in ('pending','running','ready','stale','failed')),
  index_error   text,
  indexed_at    timestamptz,
  file_count    integer not null default 0,
  symbol_count  integer not null default 0,
  size_bytes    bigint not null default 0,
  health        jsonb not null default '{}'::jsonb,
  settings      jsonb not null default '{}'::jsonb,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, slug)
);

drop trigger if exists projects_touch on projects;
create trigger projects_touch before update on projects for each row execute function app.touch_updated_at();

create index if not exists projects_org_idx on projects (org_id, updated_at desc);
create index if not exists projects_name_trgm on projects using gin (name gin_trgm_ops);

-- Project-level access predicate. Membership in the owning org is the base
-- rule; project_members can narrow or extend it for a single project.
create or replace function app.project_org(target_project uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from projects where id = target_project
$$;

create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists project_members_user_idx on project_members (user_id);

create or replace function app.can_read_project(target_project uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_org_member(app.project_org(target_project), uid)
      or exists (select 1 from project_members pm where pm.project_id = target_project and pm.user_id = uid)
$$;

create or replace function app.can_write_project(target_project uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select app.can_write_org(app.project_org(target_project), uid)
      or exists (select 1 from project_members pm
                 where pm.project_id = target_project and pm.user_id = uid and pm.role in ('owner','admin','member'))
$$;

-- ─── repositories & branches ────────────────────────────────────────────────
create table if not exists repositories (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  provider       text not null default 'github' check (provider in ('github','gitlab','local','upload')),
  external_id    text,
  owner          text,
  name           text,
  full_name      text,
  clone_url      text,
  html_url       text,
  default_branch text not null default 'main',
  visibility     text not null default 'private',
  -- encrypted with DIROX_ENCRYPTION_KEY; never returned to the browser
  access_token_enc text,
  installed_by   uuid references auth.users(id) on delete set null,
  last_synced_at timestamptz,
  sync_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists repositories_touch on repositories;
create trigger repositories_touch before update on repositories for each row execute function app.touch_updated_at();

create unique index if not exists repositories_project_unique on repositories (project_id);
create index if not exists repositories_full_name_idx on repositories (full_name);

create table if not exists branches (
  id            uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id) on delete cascade,
  name          text not null,
  head_sha      text,
  is_default    boolean not null default false,
  last_seen_at  timestamptz not null default now(),
  unique (repository_id, name)
);

-- ─── indexed source files ───────────────────────────────────────────────────
-- Content itself is NOT stored here: only metadata and a compressed summary.
-- Full text lives in object storage or is read from the workspace on demand.
create table if not exists files (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  path         text not null,
  directory    text not null default '',
  extension    text,
  language     text,
  size_bytes   integer not null default 0,
  line_count   integer not null default 0,
  content_hash text not null,
  summary      text,
  summary_tokens integer not null default 0,
  importance   real not null default 0,
  is_binary    boolean not null default false,
  is_generated boolean not null default false,
  last_modified_at timestamptz,
  indexed_at   timestamptz not null default now(),
  unique (project_id, path)
);

create index if not exists files_project_dir_idx on files (project_id, directory);
create index if not exists files_path_trgm on files using gin (path gin_trgm_ops);
create index if not exists files_hash_idx on files (project_id, content_hash);

create table if not exists code_symbols (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  file_id     uuid not null references files(id) on delete cascade,
  name        text not null,
  kind        text not null default 'symbol'
              check (kind in ('function','class','method','interface','type','const','component','route','test','symbol')),
  signature   text,
  start_line  integer not null default 1,
  end_line    integer not null default 1,
  is_exported boolean not null default false,
  doc         text,
  created_at  timestamptz not null default now()
);

create index if not exists code_symbols_project_name_idx on code_symbols (project_id, name);
create index if not exists code_symbols_file_idx on code_symbols (file_id);
create index if not exists code_symbols_name_trgm on code_symbols using gin (name gin_trgm_ops);

-- Import/dependency edges power "which files are related" without an LLM call.
create table if not exists file_dependencies (
  project_id  uuid not null references projects(id) on delete cascade,
  from_file_id uuid not null references files(id) on delete cascade,
  to_path     text not null,
  to_file_id  uuid references files(id) on delete set null,
  kind        text not null default 'import',
  primary key (project_id, from_file_id, to_path)
);

create index if not exists file_dependencies_to_idx on file_dependencies (project_id, to_file_id);

-- Embeddings are optional: hybrid retrieval works without pgvector installed.
-- Enable the extension and this table only if semantic search is wanted.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    -- Availability does not imply permission to create it, and semantic search
    -- is optional: hybrid retrieval works on keywords and symbols without it.
    begin
      execute 'create extension if not exists vector';
    exception when others then
      raise notice 'vector extension unavailable (%); semantic search stays disabled', sqlerrm;
      return;
    end;

    execute $ddl$
      create table if not exists file_embeddings (
        id         uuid primary key default gen_random_uuid(),
        project_id uuid not null references projects(id) on delete cascade,
        file_id    uuid not null references files(id) on delete cascade,
        chunk_index integer not null default 0,
        start_line integer not null default 1,
        end_line   integer not null default 1,
        content_hash text not null,
        embedding  vector(1536),
        created_at timestamptz not null default now(),
        unique (file_id, chunk_index)
      )
    $ddl$;
    execute 'create index if not exists file_embeddings_project_idx on file_embeddings (project_id)';
  end if;
end $$;

-- ─── project memory ─────────────────────────────────────────────────────────
-- Durable knowledge the agent accumulates. Never used for secrets.
create table if not exists project_memory (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  scope      text not null default 'project' check (scope in ('project','user')),
  kind       text not null default 'note'
             check (kind in ('architecture','convention','rule','dependency','bug','deployment','preference','solution','note')),
  key        text,
  content    text not null,
  tokens     integer not null default 0,
  importance real not null default 0.5,
  source     text not null default 'agent' check (source in ('agent','user','system')),
  hit_count  integer not null default 0,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_memory_scope_target check (
    (scope = 'project' and project_id is not null) or (scope = 'user' and user_id is not null)
  )
);

drop trigger if exists project_memory_touch on project_memory;
create trigger project_memory_touch before update on project_memory for each row execute function app.touch_updated_at();

create index if not exists project_memory_project_idx on project_memory (project_id, kind, importance desc);
create index if not exists project_memory_user_idx on project_memory (user_id, kind);
create unique index if not exists project_memory_unique_key on project_memory (project_id, kind, key)
  where key is not null and project_id is not null;

-- ─── checkpoints ────────────────────────────────────────────────────────────
create table if not exists checkpoints (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  task_id     uuid,
  step_index  integer,
  label       text not null default '',
  kind        text not null default 'auto' check (kind in ('auto','manual','pre_task','post_task')),
  git_sha     text,
  -- patch is stored inline only when small; larger diffs go to object storage
  patch       text,
  patch_url   text,
  files       jsonb not null default '[]'::jsonb,
  size_bytes  integer not null default 0,
  restored_at timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists checkpoints_project_idx on checkpoints (project_id, created_at desc);
create index if not exists checkpoints_task_idx on checkpoints (task_id);

create table if not exists git_operations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  task_id     uuid,
  user_id     uuid references auth.users(id) on delete set null,
  operation   text not null check (operation in ('clone','pull','commit','push','branch','checkout','revert','reset','pull_request','merge')),
  branch      text,
  sha         text,
  message     text,
  status      text not null default 'success' check (status in ('success','failed','pending')),
  error       text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists git_operations_project_idx on git_operations (project_id, created_at desc);
