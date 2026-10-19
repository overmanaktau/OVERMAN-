-- Курсор журнала МойСклад для остальных изменений (товары, склад, документы, справочники): отдельно от курсора чеков и возвратов.
alter table public.moysklad_sync_state add column if not exists audit_cursor_all text;
