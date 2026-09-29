-- Трафик и каналы: re-introduce date gating that migration 018 removed,
-- but with the rule the business wants now — freely enter/edit yesterday,
-- today, or ANY future date; anything older needs an approved request
-- first (same request/unlock flow extra_expenses already uses via
-- app/api/edit-requests/[id]/approve, which already handles both an
-- existing row_id and a not-yet-existing row keyed by entry_date — that
-- route needs no changes). The request covers the whole row (all 7 fields)
-- at once, not per field.

drop policy if exists traffic_entries_insert on public.traffic_entries;
create policy traffic_entries_insert on public.traffic_entries
  for insert with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and entry_date >= (current_date - 1)
  );

drop policy if exists traffic_entries_update on public.traffic_entries;
create policy traffic_entries_update on public.traffic_entries
  for update using (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (
      entry_date >= (current_date - 1)
      or (unlock_expires_at is not null and unlock_expires_at > now())
    )
  )
  with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
  );
