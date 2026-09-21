-- Revised date rules for traffic_entries:
--  - Any PAST date (not just yesterday) is free for first-time entry —
--    changing it again afterwards still needs a request, same as before.
--  - A FUTURE date can only ever have "Трафик план" filled in — the six
--    actual-data columns must stay null until that date arrives.
drop policy if exists traffic_entries_insert on public.traffic_entries;
create policy traffic_entries_insert on public.traffic_entries
  for insert with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (
      entry_date <= current_date
      or (
        entry_date > current_date
        and traffic_fact is null
        and instagram is null
        and tiktok is null
        and instagram_public is null
        and flyer is null
        and two_gis is null
      )
    )
  );

drop policy if exists traffic_entries_update on public.traffic_entries;
create policy traffic_entries_update on public.traffic_entries
  for update using (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (not locked or (unlock_expires_at is not null and unlock_expires_at > now()))
  )
  with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (
      entry_date <= current_date
      or (
        entry_date > current_date
        and traffic_fact is null
        and instagram is null
        and tiktok is null
        and instagram_public is null
        and flyer is null
        and two_gis is null
      )
    )
  );
