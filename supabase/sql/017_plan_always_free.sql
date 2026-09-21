-- Corrected date/field rules for traffic_entries:
--  - "Трафик план" is always free to fill or change — any date, any time,
--    first entry or the hundredth edit — never needs a request.
--  - The six actual-data columns are free for first-time entry only on
--    yesterday's or today's date; any other date needs an approved request
--    even for the very first entry. Changing an already-saved value in
--    those six columns again always needs a request, regardless of date.
-- A single "locked" flag can't express "this column is free, these six
-- aren't", so the six columns are guarded by a trigger comparing OLD/NEW
-- instead of by the row-level RLS check alone.

create or replace function public.traffic_entries_guard_locked_fields()
returns trigger as $$
begin
  if OLD.locked and (OLD.unlock_expires_at is null or OLD.unlock_expires_at <= now()) then
    if NEW.traffic_fact is distinct from OLD.traffic_fact
       or NEW.instagram is distinct from OLD.instagram
       or NEW.tiktok is distinct from OLD.tiktok
       or NEW.instagram_public is distinct from OLD.instagram_public
       or NEW.flyer is distinct from OLD.flyer
       or NEW.two_gis is distinct from OLD.two_gis
    then
      raise exception 'Изменение этих полей требует одобренного запроса.' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists traffic_entries_guard_locked_fields_trigger on public.traffic_entries;
create trigger traffic_entries_guard_locked_fields_trigger
  before update on public.traffic_entries
  for each row execute function public.traffic_entries_guard_locked_fields();

drop policy if exists traffic_entries_insert on public.traffic_entries;
create policy traffic_entries_insert on public.traffic_entries
  for insert with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (
      (entry_date >= (current_date - 1) and entry_date <= current_date)
      or (
        traffic_fact is null and instagram is null and tiktok is null
        and instagram_public is null and flyer is null and two_gis is null
      )
    )
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
