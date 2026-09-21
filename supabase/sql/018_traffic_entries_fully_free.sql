-- Drop the whole request/lock gate for traffic_entries — first entry and
-- any later correction are both free, any date, any field, for anyone with
-- edit access to their store. The "locked"/"unlock_expires_at" columns and
-- the trigger from the previous pass are no longer used for gating.

drop trigger if exists traffic_entries_guard_locked_fields_trigger on public.traffic_entries;
drop function if exists public.traffic_entries_guard_locked_fields();

drop policy if exists traffic_entries_insert on public.traffic_entries;
create policy traffic_entries_insert on public.traffic_entries
  for insert with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
  );

drop policy if exists traffic_entries_update on public.traffic_entries;
create policy traffic_entries_update on public.traffic_entries
  for update using (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
  )
  with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
  );
