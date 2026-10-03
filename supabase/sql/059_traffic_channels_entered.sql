-- Признак «каналы внесены» у строки трафика. Раньше строку закрывали фактом
-- (уже внесённая строка за вчера правится только по запросу), но факт теперь
-- пишет автозагрузка из счётчиков и план вносится заранее на месяц — ни то ни
-- другое строку закрывать не должно. Строку закрывает именно первичное
-- внесение остальных данных (каналов: Instagram, TikTok, Insta паблик, Флаер,
-- 2ГИС). Каналы по умолчанию 0, поэтому «внесено или нулевые по умолчанию»
-- по самим значениям не отличить — нужен отдельный флаг, его ставит страница
-- «Внесение данных» при сохранении каналов.

alter table public.traffic_entries
  add column if not exists channels_entered boolean not null default false;

-- Уже внесённые вручную строки остаются внесёнными: у всех у них каналы
-- ненулевые. Строки только с фактом/планом (автозагрузка, план) — нет.
update public.traffic_entries
set channels_entered = true
where coalesce(instagram, 0) + coalesce(tiktok, 0) + coalesce(instagram_public, 0)
    + coalesce(flyer, 0) + coalesce(two_gis, 0) <> 0;

-- Правка существующей строки: сегодня и позже — свободно; вчера — свободно,
-- только пока каналы ещё не вносились (первичное внесение); после него и для
-- более старых дат — по одобренному запросу (окно unlock_expires_at).
drop policy if exists traffic_entries_update on public.traffic_entries;
create policy traffic_entries_update on public.traffic_entries
  for update using (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
    and (
      entry_date >= current_date
      or (entry_date >= (current_date - 1) and not channels_entered)
      or (unlock_expires_at is not null and unlock_expires_at > now())
    )
  )
  with check (
    public.has_access('marketing.data_entry', 'edit')
    and public.has_store_access(store)
  );

-- Флаг нельзя снять: уже внесённая строка остаётся внесённой.
create or replace function public.traffic_entries_keep_channels_entered()
returns trigger
language plpgsql
as $$
begin
  new.channels_entered := old.channels_entered or new.channels_entered;
  return new;
end;
$$;

drop trigger if exists traffic_entries_keep_channels_entered_trigger on public.traffic_entries;
create trigger traffic_entries_keep_channels_entered_trigger
  before update on public.traffic_entries
  for each row
  execute function public.traffic_entries_keep_channels_entered();
