-- ============================================================================
-- DiroxCode — 0001 core: identity, tenancy, plans
-- ============================================================================
-- Run migrations in filename order in the Supabase SQL editor.
-- Every statement is idempotent so re-running a migration is safe.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ─── helpers ────────────────────────────────────────────────────────────────
-- These are SECURITY DEFINER so RLS policies can call them without recursing
-- into the very tables they protect.

create schema if not exists app;

create or replace function app.current_user_id() returns uuid
language sql stable as $$ select auth.uid() $$;

-- ─── profiles ───────────────────────────────────────────────────────────────
create table if not exists profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text,
  full_name         text,
  username          text unique,
  avatar_url        text,
  timezone          text        not null default 'UTC',
  locale            text        not null default 'en',
  -- developer profile
  experience_level  text        not null default 'intermediate'
                    check (experience_level in ('beginner','intermediate','advanced','expert')),
  primary_languages text[]      not null default '{}',
  preferred_frameworks text[]   not null default '{}',
  coding_style      jsonb       not null default '{}'::jsonb,
  -- ai preferences (default model, reasoning, autonomy, verbosity, auto-test…)
  ai_preferences    jsonb       not null default '{}'::jsonb,
  notification_preferences jsonb not null default
                    '{"task_completed":true,"task_failed":true,"approval_required":true,"security":true,"billing":true}'::jsonb,
  onboarded_at      timestamptz,
  suspended_at      timestamptz,
  suspension_reason text,
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table profiles is 'Public profile + preferences for each auth user. One row per auth.users row.';

create index if not exists profiles_email_idx on profiles (lower(email));

-- Keep a profile in step with auth.users automatically.
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- Generic updated_at trigger reused by every mutable table.
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles
  for each row execute function app.touch_updated_at();

-- ─── platform administrators ────────────────────────────────────────────────
create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'admin' check (role in ('admin','superadmin')),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table platform_admins is 'Membership here grants access to the DiroxCode admin dashboard. Seed the first row manually.';

create or replace function app.is_platform_admin(uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = uid)
$$;

-- ─── plans ──────────────────────────────────────────────────────────────────
-- Pricing and limits are data, never constants in code: the admin edits rows.
create table if not exists plans (
  id                  uuid primary key default gen_random_uuid(),
  code                text unique not null,
  name                text not null,
  description         text not null default '',
  price_monthly_cents integer not null default 0,
  price_yearly_cents  integer not null default 0,
  currency            text not null default 'usd',
  -- limits: null means "unlimited"
  included_credits_cents integer not null default 0,
  max_projects        integer,
  max_tasks_per_day   integer,
  max_tokens_per_month bigint,
  max_cost_per_month_cents integer,
  max_concurrent_agents integer not null default 1,
  max_repo_mb         integer not null default 200,
  requests_per_minute integer not null default 60,
  allowed_model_tiers text[] not null default '{level0,level1,level2}',
  features            jsonb not null default '{}'::jsonb,
  stripe_price_id_monthly text,
  stripe_price_id_yearly  text,
  is_public           boolean not null default true,
  is_default          boolean not null default false,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists plans_touch on plans;
create trigger plans_touch before update on plans for each row execute function app.touch_updated_at();

create unique index if not exists plans_single_default on plans (is_default) where is_default;

-- ─── organizations (multi-tenancy) ──────────────────────────────────────────
create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  avatar_url  text,
  owner_id    uuid not null references auth.users(id) on delete restrict,
  plan_id     uuid references plans(id) on delete set null,
  is_personal boolean not null default false,
  settings    jsonb not null default '{}'::jsonb,
  suspended_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists organizations_touch on organizations;
create trigger organizations_touch before update on organizations for each row execute function app.touch_updated_at();

create index if not exists organizations_owner_idx on organizations (owner_id);

create table if not exists organization_members (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','admin','member','viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists organization_members_user_idx on organization_members (user_id);

-- Tenancy predicates used by nearly every RLS policy below.
create or replace function app.is_org_member(target_org uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from organization_members m where m.org_id = target_org and m.user_id = uid)
$$;

create or replace function app.org_role(target_org uuid, uid uuid default auth.uid()) returns text
language sql stable security definer set search_path = public as $$
  select m.role from organization_members m where m.org_id = target_org and m.user_id = uid
$$;

create or replace function app.can_admin_org(target_org uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app.org_role(target_org, uid) in ('owner','admin'), false)
$$;

create or replace function app.can_write_org(target_org uuid, uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app.org_role(target_org, uid) in ('owner','admin','member'), false)
$$;

-- ─── subscriptions ──────────────────────────────────────────────────────────
create table if not exists subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  plan_id              uuid not null references plans(id) on delete restrict,
  status               text not null default 'active'
                       check (status in ('trialing','active','past_due','canceled','incomplete','paused')),
  billing_interval     text not null default 'monthly' check (billing_interval in ('monthly','yearly')),
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz not null default (now() + interval '30 days'),
  cancel_at_period_end boolean not null default false,
  canceled_at          timestamptz,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  credits_cents        integer not null default 0,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

drop trigger if exists subscriptions_touch on subscriptions;
create trigger subscriptions_touch before update on subscriptions for each row execute function app.touch_updated_at();

create unique index if not exists subscriptions_active_per_org
  on subscriptions (org_id) where status in ('trialing','active','past_due');
create index if not exists subscriptions_period_idx on subscriptions (current_period_end);
