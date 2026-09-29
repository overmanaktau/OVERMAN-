-- Bell icon next to the account menu: system notifications (starting with
-- sync failures — the exact "nightly sync silently failing" problem this
-- app already hit once) so a failure surfaces on the site instead of only
-- in moysklad_sync_state, which nobody was checking proactively.
--
-- Read state is per-user but doesn't need a row per notification: a single
-- "last_read_at" timestamp per user is enough — anything created after it
-- counts as unread. Opening the bell bumps that timestamp to now.

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  type text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists notifications_created_at_idx on public.notifications (created_at desc);

alter table public.notifications enable row level security;

create policy notifications_select_authenticated on public.notifications
  for select using (auth.role() = 'authenticated');

create table if not exists public.user_notification_reads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now()
);

alter table public.user_notification_reads enable row level security;

create policy user_notification_reads_own on public.user_notification_reads
  for select using (auth.uid() = user_id);

create policy user_notification_reads_upsert_own on public.user_notification_reads
  for insert with check (auth.uid() = user_id);

create policy user_notification_reads_update_own on public.user_notification_reads
  for update using (auth.uid() = user_id);
