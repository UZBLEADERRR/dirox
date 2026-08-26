-- ============================================================================
-- DiroxCode — 0003 agent: conversations, tasks, steps, tool calls
-- ============================================================================

create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references projects(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'New conversation',
  mode        text not null default 'agent' check (mode in ('ask','edit','agent','autopilot','review','debug','plan')),
  -- rolling compression: older turns collapse into `summary`
  summary     text not null default '',
  summary_tokens integer not null default 0,
  summarized_through integer not null default 0,
  message_count integer not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists conversations_touch on conversations;
create trigger conversations_touch before update on conversations for each row execute function app.touch_updated_at();

create index if not exists conversations_project_idx on conversations (project_id, updated_at desc);
create index if not exists conversations_user_idx on conversations (user_id, updated_at desc);

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  task_id         uuid,
  role            text not null check (role in ('user','assistant','system','tool')),
  -- rendered text; structured payloads live in message_parts
  content         text not null default '',
  sequence        integer not null,
  tokens          integer not null default 0,
  model_id        uuid,
  cost_micros     bigint not null default 0,
  -- true once this message has been folded into conversations.summary
  compacted       boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (conversation_id, sequence)
);

create index if not exists messages_conversation_idx on messages (conversation_id, sequence);
create index if not exists messages_task_idx on messages (task_id);
create index if not exists messages_content_trgm on messages using gin (content gin_trgm_ops);

create table if not exists message_parts (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  kind       text not null check (kind in ('text','code','diff','file_ref','tool_call','tool_result','activity','error','attachment','plan','review')),
  position   integer not null default 0,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists message_parts_message_idx on message_parts (message_id, position);

-- ─── tasks ──────────────────────────────────────────────────────────────────
create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  project_id      uuid references projects(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text not null,
  objective       text not null default '',
  mode            text not null default 'agent' check (mode in ('ask','edit','agent','autopilot','review','debug','plan')),
  status          text not null default 'queued'
                  check (status in ('queued','planning','running','waiting_for_approval','testing','completed','failed','cancelled')),
  complexity      text check (complexity in ('level0','level1','level2','level3','level4')),
  -- token budget engine
  budget_micros   bigint not null default 100000,   -- 1e-6 USD units; 100000 = $0.10
  spent_micros    bigint not null default 0,
  input_tokens    bigint not null default 0,
  output_tokens   bigint not null default 0,
  cached_tokens   bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  iterations      integer not null default 0,
  max_iterations  integer not null default 18,
  plan            jsonb not null default '{}'::jsonb,
  result          jsonb not null default '{}'::jsonb,
  changed_files   jsonb not null default '[]'::jsonb,
  error           text,
  error_code      text,
  approval        jsonb,
  primary_model_id uuid,
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks for each row execute function app.touch_updated_at();

create index if not exists tasks_project_idx on tasks (project_id, created_at desc);
create index if not exists tasks_user_idx on tasks (user_id, created_at desc);
create index if not exists tasks_org_status_idx on tasks (org_id, status);
create index if not exists tasks_active_idx on tasks (org_id) where status in ('queued','planning','running','waiting_for_approval','testing');

create table if not exists task_steps (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  step_index  integer not null,
  phase       text not null
              check (phase in ('classify','plan','retrieve','model','tool','observe','validate','review','checkpoint','finalize')),
  title       text not null default '',
  status      text not null default 'running' check (status in ('running','completed','failed','skipped')),
  -- concise, user-safe summary of what happened. Never raw chain-of-thought.
  summary     text not null default '',
  detail      jsonb not null default '{}'::jsonb,
  model_id    uuid,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_micros bigint not null default 0,
  duration_ms integer not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  unique (task_id, step_index)
);

create index if not exists task_steps_task_idx on task_steps (task_id, step_index);

create table if not exists tool_calls (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  step_id     uuid references task_steps(id) on delete set null,
  tool        text not null,
  arguments   jsonb not null default '{}'::jsonb,
  status      text not null default 'pending'
              check (status in ('pending','awaiting_approval','running','completed','failed','denied','cancelled','timeout')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  duration_ms integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists tool_calls_task_idx on tool_calls (task_id, created_at);
create index if not exists tool_calls_tool_idx on tool_calls (tool, status);

create table if not exists tool_results (
  id            uuid primary key default gen_random_uuid(),
  tool_call_id  uuid not null references tool_calls(id) on delete cascade,
  ok            boolean not null default true,
  -- output is already truncated and summarised by the tool executor
  output        text not null default '',
  output_tokens integer not null default 0,
  truncated     boolean not null default false,
  metadata      jsonb not null default '{}'::jsonb,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists tool_results_call_idx on tool_results (tool_call_id);

-- Task-scoped foreign keys added after tasks exists.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'checkpoints_task_fk') then
    alter table checkpoints add constraint checkpoints_task_fk
      foreign key (task_id) references tasks(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'git_operations_task_fk') then
    alter table git_operations add constraint git_operations_task_fk
      foreign key (task_id) references tasks(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_task_fk') then
    alter table messages add constraint messages_task_fk
      foreign key (task_id) references tasks(id) on delete set null;
  end if;
end $$;

-- ─── code review findings ───────────────────────────────────────────────────
create table if not exists review_findings (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  task_id     uuid references tasks(id) on delete cascade,
  severity    text not null check (severity in ('critical','high','medium','low','info')),
  category    text not null default 'correctness',
  file_path   text,
  line        integer,
  title       text not null,
  detail      text not null default '',
  suggestion  text,
  status      text not null default 'open' check (status in ('open','fixed','dismissed')),
  created_at  timestamptz not null default now()
);

create index if not exists review_findings_task_idx on review_findings (task_id, severity);
create index if not exists review_findings_project_idx on review_findings (project_id, status);
