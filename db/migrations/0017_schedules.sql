-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 — scheduled work
--
-- The product's own description is "SaaS, bots, automation", and until now
-- every run began with a person typing. A queue existed; nothing put work into
-- it on a clock.
--
-- A schedule is a task waiting for a time. The same objective, the same mode,
-- the same project — run without anybody present, which is what makes the
-- difference between a tool and an automation.
--
-- Three decisions the shape encodes:
--
--   `next_run_at` is stored, not computed on read. A scheduler that has to
--   parse and project every expression on every tick does that work forever;
--   one that reads an indexed timestamp does almost none.
--
--   The timezone is part of the schedule. "Every day at 09:00" means 09:00
--   where the person is, on both sides of a daylight-saving change, and a
--   schedule kept in UTC drifts an hour twice a year.
--
--   Failures are counted and a schedule that keeps failing turns itself off.
--   An automation that fails every hour forever costs money and trains its
--   owner to ignore it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists schedules (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  project_id      uuid references projects(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,

  name            text not null,
  objective       text not null,
  mode            text not null default 'agent'
                  check (mode in ('ask','edit','agent','autopilot','review','debug','plan')),

  -- Five-field cron, and the zone the wall-clock times are in.
  cron            text not null,
  timezone        text not null default 'UTC',

  enabled         boolean not null default true,
  -- Money is bounded per run rather than per schedule: an automation that runs
  -- hourly forever should not be able to inherit an unbounded budget.
  budget_micros   bigint not null default 100000,
  -- Trust is stored, because nobody is present to approve anything. A schedule
  -- can only ever run at the level its owner chose when creating it.
  trust           text not null default 'confirm' check (trust in ('safe','confirm','autonomous')),

  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_task_id    uuid references tasks(id) on delete set null,
  last_status     text,
  consecutive_failures integer not null default 0,
  run_count       integer not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists schedules_touch on schedules;
create trigger schedules_touch before update on schedules for each row execute function app.touch_updated_at();

-- The scheduler's only query: what is due. Partial, because a disabled
-- schedule is never due and there is no reason to walk it.
create index if not exists schedules_due_idx on schedules (next_run_at)
  where enabled and next_run_at is not null;

create index if not exists schedules_org_idx on schedules (org_id, created_at desc);
create index if not exists schedules_project_idx on schedules (project_id) where project_id is not null;

comment on column schedules.next_run_at is
  'When this fires next, computed on write. The scheduler reads an indexed timestamp rather than parsing every expression on every tick.';
comment on column schedules.trust is
  'What the run is allowed to do without asking. Nobody is present to approve anything, so this is chosen once, by a person, when the schedule is made.';

-- ─── who can see a schedule ─────────────────────────────────────────────────

alter table schedules enable row level security;

drop policy if exists schedules_read on schedules;
create policy schedules_read on schedules
  for select using (app.is_org_member(org_id));

drop policy if exists schedules_write on schedules;
create policy schedules_write on schedules
  for all using (app.is_org_member(org_id) and (user_id = auth.uid() or app.owns_org(org_id)))
  with check (app.is_org_member(org_id) and user_id = auth.uid());

-- ─── the run that a schedule produces ───────────────────────────────────────

alter table tasks add column if not exists schedule_id uuid references schedules(id) on delete set null;
create index if not exists tasks_schedule_idx on tasks (schedule_id, created_at desc) where schedule_id is not null;

comment on column tasks.schedule_id is
  'Set when this task was started by a schedule rather than by a person.';

insert into feature_flags (key, name, description, enabled, rollout_percentage) values
  ('schedules','Scheduled work','Running a task on a cron schedule, with nobody present.', true, 100)
on conflict (key) do nothing;
