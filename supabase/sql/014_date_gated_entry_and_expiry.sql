-- 1. First-time entry is now only free for yesterday's and today's date;
--    any other date (past or future) needs a request too, same as editing
--    an already-saved row. A request can now target a not-yet-existing row
--    (row_id null, entry_date instead), since there's nothing to reference yet.
alter table public.edit_requests alter column row_id drop not null;
alter table public.edit_requests add column if not exists entry_date date;

-- 2. An approved request only grants a 30-minute editing window. If the
--    employee doesn't save within that window, the row must be requested
--    again — enforced at the RLS level, not just in the UI.
alter table public.traffic_entries add column if not exists unlock_expires_at timestamptz;
alter table public.extra_expenses add column if not exists unlock_expires_at timestamptz;

drop policy if exists traffic_entries_insert on public.traffic_entries;
create policy traffic_entries_insert on public.traffic_entries
  for insert with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and entry_date >= (current_date - 1)
    and entry_date <= current_date
  );

drop policy if exists traffic_entries_update on public.traffic_entries;
create policy traffic_entries_update on public.traffic_entries
  for update using (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (not locked or (unlock_expires_at is not null and unlock_expires_at > now()))
  )
  with check (public.has_access('marketing.data_entry', 'edit') and public.has_store_access(store));

drop policy if exists extra_expenses_update on public.extra_expenses;
create policy extra_expenses_update on public.extra_expenses
  for update using (
    public.has_access('marketing.data_entry', 'edit')
    and (not locked or (unlock_expires_at is not null and unlock_expires_at > now()))
  )
  with check (public.has_access('marketing.data_entry', 'edit'));
