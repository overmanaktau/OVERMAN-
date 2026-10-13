-- Экран /client: клиенты делятся по городам. Город берётся из тега контрагента в МойСклад:
-- «актобе» — Актобе (point_3), иначе (тег «клиенты» / «overman») — Актау (point_1). Заполняет ночная загрузка.
alter table public.kassa_clients add column if not exists city text not null default 'point_1';
create index if not exists kassa_clients_city_last on public.kassa_clients (city, last_demand_at desc nulls last);
