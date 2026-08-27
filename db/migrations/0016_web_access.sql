-- ═══════════════════════════════════════════════════════════════════════════
-- 0016 — the agent can read the web
--
-- A coding agent without web access is stuck in whenever its model was
-- trained. Half of real work is looking something up: an API that changed last
-- month, why a version broke, what a payment provider's status code means.
--
-- One flag, because this is the one capability that sends a request our
-- container makes to an address a model chose. A deployment that would rather
-- not can turn it off here, and the tools then never reach a model.
-- ═══════════════════════════════════════════════════════════════════════════

insert into feature_flags (key, name, description, enabled, rollout_percentage) values
  ('web_access','Web access','Searching the web and reading pages, through an SSRF-guarded fetch.', true, 100)
on conflict (key) do nothing;
