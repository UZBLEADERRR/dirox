-- ═══════════════════════════════════════════════════════════════════════════
-- 0015 — long runs and sub-agents
--
-- Two limits are removed here, and both were arbitrary.
--
-- The first was a hard ceiling of forty steps in the orchestrator. A real
-- task — "add Stripe billing", "port this to Postgres" — is not forty steps,
-- and stopping at forty produced a half-finished repository and a message
-- apologising for it. Budget, not a step count, is the honest limit: the run
-- stops when the money runs out, when it stops making progress, or when the
-- wall clock says the container will not survive another step.
--
-- The second was that a run held everything it knew in memory. A container
-- replacement, a deploy, an approval pause — any of them threw away the
-- conversation, the loaded tool groups and the pending tool call, and the only
-- recovery was to start again and pay again. `run_state` makes a run something
-- that can be picked up.
--
-- Sub-agents are the third piece: a delegated run is a task of its own, so it
-- has its own budget, its own timeline and its own cost, and the parent sees
-- one paragraph instead of forty tool results.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── resumable runs ─────────────────────────────────────────────────────────

alter table tasks add column if not exists run_state jsonb not null default '{}'::jsonb;

comment on column tasks.run_state is
  'Everything a run needs to be picked up where it stopped: the trimmed conversation, changed files, loaded tool groups, the tool calls that were pending approval, and how far it had got. Cleared when the task finishes.';

-- Forty was the ceiling; eighteen was the default under it. Neither number
-- came from a measurement. The default is now what a substantial task actually
-- takes, and the ceiling lives in agent.defaults where an operator can see it.
alter table tasks alter column max_iterations set default 40;

-- ─── sub-agents ─────────────────────────────────────────────────────────────

alter table tasks add column if not exists parent_task_id uuid references tasks(id) on delete cascade;
alter table tasks add column if not exists delegated_role text;

comment on column tasks.parent_task_id is
  'Set when this task is a sub-agent run spawned by another task. Its cost rolls up to the same org and user, and its timeline is its own.';

create index if not exists tasks_parent_idx on tasks (parent_task_id) where parent_task_id is not null;

-- A delegated run is not something a person queued, so it must not appear in
-- the active-work index that drives concurrency limits and the task list.
drop index if exists tasks_active_idx;
create index if not exists tasks_active_idx on tasks (org_id)
  where status in ('queued','planning','running','waiting_for_approval','testing')
    and parent_task_id is null;

-- ─── new phases on the timeline ─────────────────────────────────────────────
--
-- `intent` and `delegate` are real steps that had nowhere to be recorded, so
-- persisting them failed silently and the timeline had holes in it.

alter table task_steps drop constraint if exists task_steps_phase_check;
alter table task_steps add constraint task_steps_phase_check
  check (phase in ('intent','classify','plan','retrieve','model','tool','observe',
                   'validate','review','checkpoint','delegate','finalize'));

-- ─── limits an operator can change without a deploy ─────────────────────────

update system_settings
   set value = value
     || '{"max_iterations":40,"iteration_ceiling":200,"max_runtime_ms":2700000,"stall_window":6,"delegation_depth":2,"delegation_budget_share":0.35}'::jsonb,
       description = 'Agent loop safety limits, run length, delegation limits and the default per-task budget.'
 where key = 'agent.defaults';

insert into system_settings (key, value, description) values
  ('agent.delegation',
   '{"enabled":true,"max_children":6,"child_iterations":14}'::jsonb,
   'Sub-agent limits: whether a run may delegate at all, how many children one run may spawn, and how long each may work.')
on conflict (key) do nothing;

-- One switch for the whole mechanism. A deployment that would rather pay for
-- one long conversation than several short ones can turn it off without a
-- deploy, and the tool then never reaches a model.
insert into feature_flags (key, name, description, enabled, rollout_percentage) values
  ('sub_agents','Sub-agents','Delegating a scoped piece of work to a child run with its own budget and its own conversation.', true, 100)
on conflict (key) do nothing;
