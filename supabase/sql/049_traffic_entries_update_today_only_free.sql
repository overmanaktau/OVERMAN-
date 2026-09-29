-- Refines 048: changing an ALREADY-SAVED row is now free only for
-- today/future — correcting a yesterday (or older) entry needs an approved
-- request too, same as any other past-date change. First-time entry
-- (insert) stays free for yesterday+ (unchanged — that policy is untouched).
drop policy if exists traffic_entries_update on public.traffic_entries;
create policy traffic_entries_update on public.traffic_entries
  for update using (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (
      entry_date >= current_date
      or (unlock_expires_at is not null and unlock_expires_at > now())
    )
  )
  with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
  );
