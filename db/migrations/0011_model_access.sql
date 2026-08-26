-- ─────────────────────────────────────────────────────────────────────────────
-- Which models a user may choose
--
-- `enabled` and `user_selectable` answer different questions, and conflating
-- them is how a cheap classifier model ends up in a customer's model picker,
-- or how an expensive model that the router needs internally becomes a
-- one-click way to spend a budget.
--
--   enabled          the router may use it at all
--   user_selectable  a user may pick it by hand in the chat panel
--
-- Default false: a newly added model is available to routing and to nobody
-- else until an administrator opens it deliberately.
-- ─────────────────────────────────────────────────────────────────────────────

alter table models add column if not exists user_selectable boolean not null default false;

comment on column models.user_selectable is
  'May a user choose this model directly in the chat panel? Administrator-controlled; independent of enabled.';

create index if not exists models_selectable_idx on models (user_selectable) where user_selectable;

-- Open the everyday tiers, so the picker is not empty on an existing install.
-- Reasoning and frontier models stay closed until an administrator opens them.
update models
   set user_selectable = true
 where enabled
   and not supports_reasoning
   and tiers && array['level0','level1','level2'];

-- PostgREST caches the schema; ask it to reload so the new column resolves.
-- Harmless where nothing is listening on that channel.
do $$
begin
  notify pgrst, 'reload schema';
exception when others then
  null;
end $$;
