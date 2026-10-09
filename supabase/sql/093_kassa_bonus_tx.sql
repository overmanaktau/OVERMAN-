-- Бонусные операции МойСклад для кассы. Список операций в МойСклад отдаётся очень медленно (≈0,3 с на строку),
-- поэтому копим их у себя и каждую ночь докачиваем только изменившиеся (по полю updated).
create table if not exists public.kassa_bonus_tx (
  ms_id text primary key,
  client_ms_id text not null,
  moment timestamptz not null,
  kind text not null check (kind in ('earn', 'spend')),
  value numeric not null,
  status text not null default 'COMPLETED',
  parent_type text not null default '',
  parent_id text not null default '',
  updated_at_ms timestamptz not null
);
create index if not exists kassa_bonus_tx_client on public.kassa_bonus_tx (client_ms_id);
create index if not exists kassa_bonus_tx_updated on public.kassa_bonus_tx (updated_at_ms);
alter table public.kassa_bonus_tx enable row level security;

create table if not exists public.kassa_sync_state (
  id boolean primary key default true check (id),
  tx_cursor timestamptz,      -- докуда докачаны операции (по updated)
  tx_done boolean not null default false, -- первичная загрузка завершена
  last_run_at timestamptz,
  last_error text
);
insert into public.kassa_sync_state (id) values (true) on conflict (id) do nothing;
alter table public.kassa_sync_state enable row level security;
