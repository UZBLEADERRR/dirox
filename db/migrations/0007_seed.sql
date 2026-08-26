-- ============================================================================
-- DiroxCode — 0007 seed: plans, providers, models, routing, flags
-- ============================================================================
-- Seed values are starting points an administrator is expected to edit in the
-- admin dashboard. Prices are per MILLION tokens in micro-USD:
--   $0.15 / 1M tokens  ->  150_000 micros
-- Verify every price against the provider's current price list before going
-- live; these figures are defaults, not a guarantee.

-- ─── plans ──────────────────────────────────────────────────────────────────
insert into plans (code, name, description, price_monthly_cents, price_yearly_cents,
                   included_credits_cents, max_projects, max_tasks_per_day, max_tokens_per_month,
                   max_cost_per_month_cents, max_concurrent_agents, max_repo_mb, requests_per_minute,
                   allowed_model_tiers, features, is_public, is_default, sort_order)
values
  ('free','Free','Explore DiroxCode on personal projects.',
   0, 0, 100, 2, 15, 1000000, 100, 1, 100, 30,
   '{level0,level1}',
   '{"github":true,"code_review":false,"visual_agent":false,"background_agent":false,"autopilot":false,"api_access":false}'::jsonb,
   true, true, 10),
  ('pro','Pro','For professional developers shipping real software.',
   2900, 29000, 3000, 25, 300, 40000000, 3000, 3, 500, 120,
   '{level0,level1,level2,level3}',
   '{"github":true,"code_review":true,"visual_agent":true,"background_agent":true,"autopilot":true,"api_access":true}'::jsonb,
   true, false, 20),
  ('team','Team','Shared projects, shared memory, shared budget.',
   9900, 99000, 12000, 100, 2000, 200000000, 12000, 8, 2000, 300,
   '{level0,level1,level2,level3,level4}',
   '{"github":true,"code_review":true,"visual_agent":true,"background_agent":true,"autopilot":true,"api_access":true,"sso":false,"audit_export":true}'::jsonb,
   true, false, 30),
  ('enterprise','Enterprise','Custom limits, dedicated support, contractual terms.',
   0, 0, 0, null, null, null, null, 25, 10000, 1000,
   '{level0,level1,level2,level3,level4}',
   '{"github":true,"code_review":true,"visual_agent":true,"background_agent":true,"autopilot":true,"api_access":true,"sso":true,"audit_export":true,"custom_models":true}'::jsonb,
   true, false, 40)
on conflict (code) do nothing;

-- ─── providers ──────────────────────────────────────────────────────────────
-- key_ref names the environment variable; the key itself never enters the DB.
insert into model_providers (code, name, adapter, base_url, key_ref, enabled, priority)
values
  ('openrouter','OpenRouter','openrouter','https://openrouter.ai/api/v1','OPENROUTER_API_KEY', true, 10),
  ('openai','OpenAI','openai','https://api.openai.com/v1','OPENAI_API_KEY', false, 20),
  ('anthropic','Anthropic','anthropic','https://api.anthropic.com/v1','ANTHROPIC_API_KEY', false, 20),
  ('google','Google','google','https://generativelanguage.googleapis.com/v1beta','GOOGLE_API_KEY', false, 30),
  ('deepseek','DeepSeek','openai','https://api.deepseek.com/v1','DEEPSEEK_API_KEY', false, 40),
  ('xai','xAI','openai','https://api.x.ai/v1','XAI_API_KEY', false, 40),
  ('moonshot','Moonshot','openai','https://api.moonshot.ai/v1','MOONSHOT_API_KEY', false, 50)
on conflict (code) do nothing;

-- ─── models ─────────────────────────────────────────────────────────────────
-- A deliberately small starting catalogue routed through OpenRouter, chosen to
-- cover every routing level from cheapest to strongest.
with p as (select id from model_providers where code = 'openrouter')
insert into models (provider_id, code, name, description,
                    input_price_micros, output_price_micros, cached_input_price_micros,
                    context_window, max_output, supports_reasoning, supports_vision,
                    supports_tools, supports_prompt_cache, tiers, enabled, priority)
select p.id, v.code, v.name, v.description, v.inp, v.outp, v.cached, v.ctx, v.maxout,
       v.reason, v.vision, true, v.cache, v.tiers, true, v.priority
from p, (values
  ('openai/gpt-4o-mini','Dirox Swift','Cheapest routing tier: classification, titles, formatting, trivial edits.',
    150000::bigint, 600000::bigint, 75000::bigint, 128000, 16384, false, true, true, '{level0,level1}'::text[], 10),
  ('anthropic/claude-3.5-haiku','Dirox Quick','Fast single-file edits, lookups and documentation.',
    800000::bigint, 4000000::bigint, 80000::bigint, 200000, 8192, false, true, true, '{level1,level2}'::text[], 20),
  ('openai/gpt-4.1','Dirox Build','Multi-file changes, moderate debugging and test work.',
    2000000::bigint, 8000000::bigint, 500000::bigint, 1000000, 32768, false, true, true, '{level2,level3}'::text[], 30),
  ('anthropic/claude-sonnet-4','Dirox Reason','Architecture, complex refactors and security analysis.',
    3000000::bigint, 15000000::bigint, 300000::bigint, 200000, 64000, true, true, true, '{level3,level4}'::text[], 40)
) as v(code, name, description, inp, outp, cached, ctx, maxout, reason, vision, cache, tiers, priority)
on conflict (provider_id, code) do nothing;

-- Fallback chain: each tier degrades to the tier below it.
update models m set fallback_model_id = f.id
from models f
where m.code = 'anthropic/claude-sonnet-4' and f.code = 'openai/gpt-4.1' and m.fallback_model_id is null;
update models m set fallback_model_id = f.id
from models f
where m.code = 'openai/gpt-4.1' and f.code = 'anthropic/claude-3.5-haiku' and m.fallback_model_id is null;
update models m set fallback_model_id = f.id
from models f
where m.code = 'anthropic/claude-3.5-haiku' and f.code = 'openai/gpt-4o-mini' and m.fallback_model_id is null;

-- ─── routing rules ──────────────────────────────────────────────────────────
-- category × level -> model. The router never picks a strong model for a task
-- a cheap one can serve; escalation happens only after a measured failure.
insert into model_routes (category, level, model_id, fallback_model_id, max_output_tokens, temperature, reasoning_effort, notes)
select r.category, r.level, m.id, m.fallback_model_id, r.max_out, r.temp, r.effort, r.notes
from (values
  ('classify',    'level0', 'openai/gpt-4o-mini',          256,  0.0::real, 'none',   'Intent and complexity classification. Always the cheapest model.'),
  ('title',       'level0', 'openai/gpt-4o-mini',          64,   0.3::real, 'none',   'Conversation titles.'),
  ('summarize',   'level0', 'openai/gpt-4o-mini',          1024, 0.1::real, 'none',   'File, folder and conversation summaries.'),
  ('chat',        'level0', 'openai/gpt-4o-mini',          1024, 0.4::real, 'none',   'Greetings and trivial questions.'),
  ('chat',        'level1', 'anthropic/claude-3.5-haiku',  2048, 0.3::real, 'none',   'Ordinary questions about a codebase.'),
  ('chat',        'level2', 'openai/gpt-4.1',              4096, 0.3::real, 'none',   'Questions needing real reasoning over code.'),
  ('plan',        'level1', 'anthropic/claude-3.5-haiku',  1500, 0.1::real, 'none',   'Short plans for simple tasks.'),
  ('plan',        'level2', 'openai/gpt-4.1',              2500, 0.1::real, 'none',   'Multi-step implementation plans.'),
  ('plan',        'level3', 'anthropic/claude-sonnet-4',   4000, 0.1::real, 'medium', 'Architectural plans.'),
  ('code',        'level1', 'anthropic/claude-3.5-haiku',  4096, 0.1::real, 'none',   'Single-file edits.'),
  ('code',        'level2', 'openai/gpt-4.1',              8192, 0.1::real, 'none',   'Multi-file implementation.'),
  ('code',        'level3', 'anthropic/claude-sonnet-4',  16000, 0.1::real, 'medium', 'Complex refactors.'),
  ('code',        'level4', 'anthropic/claude-sonnet-4',  32000, 0.1::real, 'high',   'Hardest engineering work.'),
  ('debug',       'level1', 'anthropic/claude-3.5-haiku',  3000, 0.1::real, 'none',   'Obvious errors.'),
  ('debug',       'level2', 'openai/gpt-4.1',              6000, 0.1::real, 'none',   'Reproduce-and-fix loops.'),
  ('debug',       'level3', 'anthropic/claude-sonnet-4',  12000, 0.1::real, 'high',   'Difficult root-cause analysis.'),
  ('review',      'level2', 'openai/gpt-4.1',              6000, 0.0::real, 'none',   'Standard code review.'),
  ('review',      'level3', 'anthropic/claude-sonnet-4',  12000, 0.0::real, 'medium', 'Security and architecture review.'),
  ('architecture','level3', 'anthropic/claude-sonnet-4',  16000, 0.2::real, 'high',   'System design.'),
  ('architecture','level4', 'anthropic/claude-sonnet-4',  32000, 0.2::real, 'high',   'Large-scale redesign.')
) as r(category, level, model_code, max_out, temp, effort, notes)
join models m on m.code = r.model_code
on conflict (category, level) do nothing;

-- ─── feature flags ──────────────────────────────────────────────────────────
insert into feature_flags (key, name, description, enabled, rollout_percentage)
values
  ('visual_agent','Visual development agent','Preview server, screenshots and console inspection.', false, 100),
  ('background_agent','Background agents','Long-running autonomous tasks through the job queue.', true, 100),
  ('github_integration','GitHub integration','Repository connection, commits and pull requests.', true, 100),
  ('advanced_models','Advanced models','Access to level 3 and level 4 routing tiers.', true, 100),
  ('autopilot','Autopilot mode','Agent continues until the task completes or blocks.', true, 100),
  ('code_review','AI code review','Severity-ranked review of changes.', true, 100),
  ('browser_agent','Browser agent','Headless browser inspection of running previews.', false, 100),
  ('terminal','Sandboxed terminal','Allowlisted command execution inside the workspace.', true, 100),
  ('semantic_search','Semantic code search','Embedding-backed retrieval alongside keyword search.', false, 100)
on conflict (key) do nothing;

-- ─── system settings ────────────────────────────────────────────────────────
insert into system_settings (key, value, description) values
  ('agent.defaults',
   '{"max_iterations":18,"default_budget_micros":100000,"loop_detection_window":3,"escalation_attempts":2,"tool_output_limit":6000}'::jsonb,
   'Agent loop safety limits and default per-task budget.'),
  ('context.budget',
   '{"level0":4000,"level1":12000,"level2":32000,"level3":80000,"level4":160000,"reserve_output":0.25}'::jsonb,
   'Maximum context tokens allowed per complexity level.'),
  ('sandbox.policy',
   '{"allow":["npm","npx","pnpm","yarn","node","python","python3","pip","pytest","go","cargo","git","ls","cat","grep","find","echo","mkdir","touch","rm","mv","cp","sed","make","jest","vitest","eslint","tsc","ruff","black"],"deny":["curl","wget","ssh","scp","sudo","su","dd","mkfs","shutdown","reboot","systemctl","docker","kubectl","chmod","chown","nc","telnet"],"confirm":["rm","git push","npm publish","npm install","pip install","migrate","deploy"]}'::jsonb,
   'Command allowlist, denylist and commands requiring explicit approval.'),
  ('billing.margin',
   '{"infrastructure_cost_monthly_cents":0,"target_margin":0.6}'::jsonb,
   'Inputs to the admin gross-margin estimate.'),
  ('alerts.cost',
   '{"daily_increase_percent":30,"model_token_spike_percent":50,"notify_admins":true}'::jsonb,
   'Thresholds for automatic AI cost alerts.')
on conflict (key) do nothing;

-- ─── evaluation suite ───────────────────────────────────────────────────────
insert into eval_suites (code, name, description, cases) values
  ('core','Core agent capability',
   'Representative tasks used to compare models before enabling them for routing.',
   '[
     {"id":"bugfix-null","category":"debug","prompt":"A function throws when its argument is undefined. Find and fix it.","expect":"guard clause added"},
     {"id":"feature-endpoint","category":"code","prompt":"Add a GET endpoint that returns the current user profile.","expect":"route registered and validated"},
     {"id":"refactor-extract","category":"code","prompt":"Extract the duplicated formatting logic into a shared helper.","expect":"single shared helper, callers updated"},
     {"id":"review-security","category":"review","prompt":"Review this diff for security problems.","expect":"identifies missing authorization check"},
     {"id":"explain-arch","category":"chat","prompt":"Explain how requests flow through this codebase.","expect":"accurate module-level description"}
   ]'::jsonb)
on conflict (code) do nothing;
