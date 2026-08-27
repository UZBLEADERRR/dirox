-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 — the project says how it ships
--
-- The agent could build an application and not put it in front of anybody,
-- which makes it a writer of code rather than a colleague. But deploying is
-- not one thing: it is `git push` to a branch a platform watches, or
-- `railway up`, or `vercel --prod`, or `make release`, or an Ansible run. We
-- do not know which, and guessing would be worse than asking.
--
-- So it sits beside `test_command` and `build_command`, and runs through the
-- same sandbox with the same allowlist. What makes it different is only that
-- its consequence leaves the container.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects add column if not exists deploy_command text;

comment on column projects.deploy_command is
  'Whatever this team actually runs to ship. Runs in the sandbox like any other command, and asks for approval below autonomous trust because its blast radius is other people.';

insert into feature_flags (key, name, description, enabled, rollout_percentage) values
  ('deploy','Deploy','Running the project''s own deploy command from the agent.', true, 100)
on conflict (key) do nothing;
