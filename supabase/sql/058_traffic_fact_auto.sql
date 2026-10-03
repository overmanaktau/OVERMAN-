-- Трафик факт теперь заполняется автоматически из счётчиков посетителей
-- (app/api/traffic/sync, service role) и вручную не вносится и не меняется.
--
-- 1. Автозаполнение не должно «закрывать» строку: раньше уже внесённая строка
--    за вчера (049) меняется только по запросу, а теперь строка за вчера
--    создаётся автозагрузкой. Возвращаем правило 048: строку за вчера и позже
--    сотрудник правит свободно (каналы и план — по своим правилам), старше —
--    по одобренному запросу.
-- 2. Факт защищён и в базе: любое вручную введённое (через сайт, а не service
--    role) изменение traffic_fact отклоняется. Автозагрузка и сервисные
--    операции идут без пользователя (auth.uid() is null) и проходят.

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

create or replace function public.traffic_entries_protect_fact()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null
     and (
       (tg_op = 'INSERT' and new.traffic_fact is not null)
       or (tg_op = 'UPDATE' and new.traffic_fact is distinct from old.traffic_fact)
     )
  then
    raise exception 'трафик факт заполняется автоматически из счётчиков и вручную не меняется';
  end if;
  return new;
end;
$$;

drop trigger if exists traffic_entries_protect_fact_trigger on public.traffic_entries;
create trigger traffic_entries_protect_fact_trigger
  before insert or update on public.traffic_entries
  for each row
  execute function public.traffic_entries_protect_fact();
