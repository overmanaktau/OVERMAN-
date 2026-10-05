-- План трафика (решение владельца 2026-10-05):
--  · на сегодня и любые будущие даты первичное внесение плана свободно — всегда;
--  · после первого внесения план блокируется, изменить его — только по одобренному
--    запросу (30-минутное окно unlock_expires_at, его открывает сервер);
--  · за прошлое (до сегодняшнего дня) план нельзя ни вносить впервые, ни менять без
--    одобренного запроса.
-- Раньше первичное внесение плана за вчера было свободным (политика вставки пускала
-- «вчера и позже»); теперь за вчера — только по запросу. Факт и каналы живут по своим
-- правилам (058, 060) и здесь не меняются.
--
-- «Сегодня» — по Алматы. Раньше правила считали current_date сервера (UTC) и ошибались
-- с 00:00 до 05:00 по Алматы; теперь все эти проверки на almaty_today().
-- Автозагрузка и сервисные операции идут без пользователя (auth.uid() is null) и проходят.

create or replace function public.almaty_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Almaty')::date
$$;

drop policy if exists traffic_entries_insert on public.traffic_entries;
create policy traffic_entries_insert on public.traffic_entries
  for insert with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and entry_date >= (public.almaty_today() - 1)
  );

create or replace function public.traffic_entries_protect_plan()
returns trigger
language plpgsql
as $$
declare
  unlock_active boolean;
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.traffic_plan is not null and new.entry_date < public.almaty_today() then
      raise exception 'дата закрыта — внести план за прошлое можно только по одобренному запросу';
    end if;
    return new;
  end if;

  unlock_active := old.unlock_expires_at is not null and old.unlock_expires_at > now();
  if unlock_active then
    return new;
  end if;

  if old.traffic_plan is not null and new.traffic_plan is distinct from old.traffic_plan then
    raise exception 'план трафика уже внесён — нужен одобренный запрос на изменение';
  end if;
  if old.traffic_plan is null and new.traffic_plan is not null and old.entry_date < public.almaty_today() then
    raise exception 'дата закрыта — внести план за прошлое можно только по одобренному запросу';
  end if;
  return new;
end;
$$;

drop trigger if exists traffic_entries_protect_plan_trigger on public.traffic_entries;
create trigger traffic_entries_protect_plan_trigger
  before insert or update on public.traffic_entries
  for each row
  execute function public.traffic_entries_protect_plan();

-- Правило каналов (060) — тот же перевод на «сегодня по Алматы».
create or replace function public.traffic_entries_guard_channels()
returns trigger
language plpgsql
as $$
declare
  unlock_active boolean := old.unlock_expires_at is not null and old.unlock_expires_at > now();
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.unlock_expires_at is distinct from old.unlock_expires_at and new.unlock_expires_at is not null then
    raise exception 'окно на изменение открывает только одобренный запрос';
  end if;

  if (new.instagram, new.tiktok, new.instagram_public, new.flyer, new.two_gis)
       is distinct from (old.instagram, old.tiktok, old.instagram_public, old.flyer, old.two_gis)
     and not unlock_active
  then
    if old.channels_entered then
      raise exception 'каналы уже внесены — нужен одобренный запрос на изменение';
    end if;
    if old.entry_date < (public.almaty_today() - 1) then
      raise exception 'дата закрыта — нужен одобренный запрос на внесение';
    end if;
  end if;

  return new;
end;
$$;
