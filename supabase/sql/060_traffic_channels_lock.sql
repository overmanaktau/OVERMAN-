-- Правило строки трафика (решение владельца):
--  · первичное внесение каналов (Instagram, TikTok, Insta паблик, Флаер, 2ГИС)
--    свободно за вчера, сегодня и любую будущую дату;
--  · после внесения изменить нельзя ни в какой день — только по одобренному
--    запросу (30-минутное окно unlock_expires_at, его открывает
--    app/api/edit-requests/[id]/approve);
--  · позавчера и старше закрыты и на внесение, и на изменение — тоже только по
--    запросу. Кнопка «Запрос» остаётся всегда.
-- Раньше внесённую строку за сегодня и будущее можно было править свободно (049,
-- 059) — теперь нет. Факт и план защищены своими триггерами (058, 053), они не
-- меняются.
--
-- Политики строк не умеют сравнивать старое и новое значение и смотреть, какие
-- колонки поменялись, поэтому сама политика update проверяет только доступ, а
-- правило выше держит триггер. Автозагрузка и сервисные операции идут без
-- пользователя (auth.uid() is null) и проходят.

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

  -- Окно на правку открывает только одобрение запроса (сервер), сотрудник сам
  -- его выставить или продлить не может.
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
    if old.entry_date < (current_date - 1) then
      raise exception 'дата закрыта — нужен одобренный запрос на внесение';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists traffic_entries_guard_channels_trigger on public.traffic_entries;
create trigger traffic_entries_guard_channels_trigger
  before update on public.traffic_entries
  for each row
  execute function public.traffic_entries_guard_channels();
