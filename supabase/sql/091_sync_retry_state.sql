-- Повтор ночной синхронизации МойСклад: считаем неудачи подряд (ночной запуск + повторы каждый час),
-- владельцу пишем только после третьей, один раз за ночь.
alter table public.moysklad_sync_state add column if not exists consecutive_failures int not null default 0;
alter table public.moysklad_sync_state add column if not exists owner_notified boolean not null default false;
