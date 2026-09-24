-- Lets an editor pause the whole Apify sync (e.g. to save budget) and/or
-- exclude individual competitors from it without deleting them.

alter table public.tracked_competitors
  add column if not exists active boolean not null default true;

create table if not exists public.competitor_sync_settings (
  id int primary key default 1 check (id = 1), -- single-row table
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.competitor_sync_settings (id, enabled)
  values (1, true)
  on conflict (id) do nothing;

alter table public.competitor_sync_settings enable row level security;

do $$
declare pol record;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('tracked_competitors', 'competitor_sync_settings')
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

create policy tracked_competitors_select on public.tracked_competitors
  for select using (public.has_access('marketing.competitor_analytics', 'view'));
create policy tracked_competitors_insert on public.tracked_competitors
  for insert with check (public.has_access('marketing.competitor_analytics', 'edit'));
create policy tracked_competitors_update on public.tracked_competitors
  for update using (public.has_access('marketing.competitor_analytics', 'edit'))
  with check (public.has_access('marketing.competitor_analytics', 'edit'));
create policy tracked_competitors_delete on public.tracked_competitors
  for delete using (public.has_access('marketing.competitor_analytics', 'edit'));

create policy competitor_sync_settings_select on public.competitor_sync_settings
  for select using (public.has_access('marketing.competitor_analytics', 'view'));
create policy competitor_sync_settings_update on public.competitor_sync_settings
  for update using (public.has_access('marketing.competitor_analytics', 'edit'))
  with check (public.has_access('marketing.competitor_analytics', 'edit'));
