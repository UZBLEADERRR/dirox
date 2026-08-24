# DiroX

DiroX is a minimalist mobile-first AI workspace for building large projects with Daho Code agent skills.

## Architecture
- **Frontend:** static `index.html`, `style.css`, `app.js`; deploy to GitHub Pages.
- **Backend:** `api/server.js`; deploy to Railway. It must not run on the phone.
- **AI:** OpenRouter proxy; never expose the API key in frontend code.
- **Data/auth:** Supabase Auth, `projects`, and `chats` tables.
- **Skill source:** only `UZBLEADERRR/Daho`, branch `claude/manashu-web-version-wclci1`, `design/dahocode` flow. No other repository is used.

## Supabase setup
Run this once in Supabase SQL Editor:

```sql
create table if not exists projects (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, name text not null, brief text default '', files jsonb default '[]', created_at timestamptz default now());
create table if not exists chats (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, project_id uuid references projects(id) on delete cascade, role text not null, content text not null, created_at timestamptz default now());
create table if not exists tasks (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, project_id uuid references projects(id) on delete cascade, title text not null, description text default '', status text not null default 'pending', state jsonb default '{}', created_at timestamptz default now());
create table if not exists admin_users (user_id uuid primary key references auth.users(id) on delete cascade, created_at timestamptz default now());
create table if not exists admin_settings (key text primary key, value text not null default '', updated_at timestamptz default now());
-- Birinchi administratorni qo‘shish: email o‘rniga Supabase Auth user UUID yozing.
-- insert into admin_users(user_id) values ('USER_UUID');
alter table projects enable row level security; alter table chats enable row level security; alter table tasks enable row level security; alter table admin_users enable row level security; alter table admin_settings enable row level security;
create policy "admins read own row" on admin_users for select using (auth.uid()=user_id);
create policy "any signed user reads model settings" on admin_settings for select using (auth.uid() is not null);
create policy "admins manage settings" on admin_settings for all using (exists (select 1 from admin_users where user_id=auth.uid())) with check (exists (select 1 from admin_users where user_id=auth.uid()));
create policy "user projects" on projects for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "user chats" on chats for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "user tasks" on tasks for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
```

## Railway variables
Set these in Railway:
- `OPENROUTER_API_KEY` — secret OpenRouter key
- `OPENROUTER_MODEL` — optional; default `openai/gpt-4o-mini`
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anon key
- `FRONTEND_URL` — deployed GitHub Pages URL
- `PORT` — Railway provides this automatically

## Admin panel
Run the SQL above, then add the first admin with `insert into admin_users(user_id) values ('SUPABASE_AUTH_USER_UUID');`. Sign in to DiroX with that account; the Admin navigation item appears automatically. Admin UI is Uzbek. Model routing is configured there and stored in `admin_settings`; normal DiroX UI is English. The OpenRouter API key is never returned to the browser and remains only in Railway as `OPENROUTER_API_KEY`. Users may write in any language; the agent is instructed to reply in the user's language.

Start command: `npm start`

## Connect frontend
Before deploying, define the Railway URL in a small script before `app.js`:

```html
<script>window.DIROX_API_URL='https://your-app.up.railway.app'</script>
<script src="app.js"></script>
```

Without this URL the UI works in local demo mode, but real Supabase auth and OpenRouter responses require Railway.

## Local test
Run `npm start`, then open the static frontend with a local static server. Check `GET /health` and use the browser test. Node backend is server-only.

## Deploy
Push the project to GitHub, enable Pages from the `main` branch root, and deploy the backend separately on Railway. Keep all API keys in Railway environment variables.
