-- Статистика reads the same raw traffic_entries/extra_expenses rows Внесение
-- данных edits, but RLS only ever checked marketing.data_entry's view flag —
-- so someone granted "view Статистика" alone (not "Внесение данных") got
-- silently empty traffic/channel-spend numbers, no error, RLS just filtered
-- every row out. Now either permission's view flag is enough to read them;
-- editing still requires marketing.data_entry specifically, unchanged.

do $$
declare pol record;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('traffic_entries', 'extra_expenses')
      and policyname like '%_select%'
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

create policy traffic_entries_select on public.traffic_entries
  for select using (
    (public.has_access('marketing.data_entry', 'view') or public.has_access('marketing.statistics', 'view'))
    and public.has_store_access(store)
  );

create policy extra_expenses_select on public.extra_expenses
  for select using (
    public.has_access('marketing.data_entry', 'view') or public.has_access('marketing.statistics', 'view')
  );
