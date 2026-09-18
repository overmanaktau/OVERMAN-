-- Locking/unlocking a month now follows the same edit permission as
-- traffic_entries/extra_expenses (marketing.data_entry), not an admin-only
-- gate. Restrict a specific role from this by removing its edit checkbox
-- for that section in Settings -> Roles, rather than a separate rule here.

drop policy if exists month_status_insert on public.month_status;
drop policy if exists month_status_update on public.month_status;

create policy month_status_insert on public.month_status
  for insert with check (public.has_access('marketing.data_entry', 'edit'));
create policy month_status_update on public.month_status
  for update using (public.has_access('marketing.data_entry', 'edit'))
  with check (public.has_access('marketing.data_entry', 'edit'));
