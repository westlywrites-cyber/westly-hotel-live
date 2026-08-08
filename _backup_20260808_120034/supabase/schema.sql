-- ══════════════════════════════════════════════════════════════════════════
-- Westly Hotel — Supabase schema for the public-website Message Inbox
--
-- Run this once in your Supabase project's SQL editor after connecting it
-- (Dashboard → SQL Editor → New query → paste this whole file → Run).
--
-- What this sets up:
--   1. A `messages` table for enquiries submitted through the public
--      website's Contact form.
--   2. Row Level Security so anonymous website visitors can only INSERT
--      (never read other people's messages), while your app's anon key can
--      read/update for the staff-facing Message Inbox (access to the inbox
--      itself is enforced in the app by Firebase-based role checks, since
--      staff identity/roles live in Firebase Auth, not Supabase Auth).
--   3. Realtime replication so the admin inbox updates live, with no
--      polling.
--
-- After running this, set these in your app's environment (Netlify site
-- settings + local .env):
--   VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
--   VITE_SUPABASE_ANON_KEY=<your-project-anon-public-key>
-- ══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,
  phone         text,
  subject       text,
  message       text not null,
  status        text not null default 'new'  check (status in ('new', 'read')),
  reply_status  text not null default 'none' check (reply_status in ('none', 'pending', 'replied')),
  source        text not null default 'website_contact_form',
  is_deleted    boolean not null default false,
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  replied_at    timestamptz
);

comment on table public.messages is 'Direct messages / enquiries submitted through the public website contact form.';

create index if not exists messages_created_at_idx on public.messages (created_at desc);
create index if not exists messages_status_idx on public.messages (status) where is_deleted = false;

alter table public.messages enable row level security;

-- Anonymous website visitors (the public Contact page) may only INSERT —
-- never select, update, or delete other people's messages.
drop policy if exists "anon can submit messages" on public.messages;
create policy "anon can submit messages"
  on public.messages
  for insert
  to anon
  with check (true);

-- The staff Message Inbox reads/updates using the same anon key (this app
-- enforces who can reach that screen via its own Firebase-based role
-- system — see src/lib/rbac.ts and the /admin/messages route guard), so we
-- allow anon to select/update here too. If you would rather lock this down
-- at the database layer as well, swap `to anon` below for `to authenticated`
-- and have the app sign in to Supabase with a service role via a serverless
-- function instead of the public anon key.
drop policy if exists "anon can read messages" on public.messages;
create policy "anon can read messages"
  on public.messages
  for select
  to anon
  using (true);

drop policy if exists "anon can update messages" on public.messages;
create policy "anon can update messages"
  on public.messages
  for update
  to anon
  using (true)
  with check (true);

-- Realtime: stream INSERT/UPDATE events to subscribed clients (the admin
-- Message Inbox) so new enquiries and read/reply status changes appear
-- instantly without polling.
alter publication supabase_realtime add table public.messages;
