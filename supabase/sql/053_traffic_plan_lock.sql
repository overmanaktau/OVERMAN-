-- Трафик план: free to set once, but changing an already-set план always
-- needs an approved request, regardless of date (unlike факт/каналы, which
-- stay free for today/future even after first entry — see the client's
-- planFieldLocked vs dayRowEffectivelyLocked in app/marketing/data-entry).
-- Enforced here too, not just client-side: the RLS update policy only
-- checks entry_date/unlock_expires_at at the row level and has no way to
-- single out one column, so a trigger comparing OLD vs NEW is what actually
-- stops a план change from slipping through in the same UPDATE as a
-- legitimate факт/каналы edit.
create or replace function public.traffic_entries_protect_plan()
returns trigger
language plpgsql
as $$
begin
  if old.traffic_plan is not null
     and new.traffic_plan is distinct from old.traffic_plan
     and (old.unlock_expires_at is null or old.unlock_expires_at <= now())
  then
    raise exception 'план трафика уже внесён — нужен одобренный запрос на изменение';
  end if;
  return new;
end;
$$;

drop trigger if exists traffic_entries_protect_plan_trigger on public.traffic_entries;
create trigger traffic_entries_protect_plan_trigger
  before update on public.traffic_entries
  for each row
  execute function public.traffic_entries_protect_plan();
