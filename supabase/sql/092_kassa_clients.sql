-- Экран кассы: клиенты из МойСклад (тег «клиенты») с расчётом бонусов по партиям.
-- Пишет только сервер (ночная загрузка и API кассы); читать напрямую из браузера нельзя (RLS без политик).
create table if not exists public.kassa_clients (
  ms_id text primary key,
  name text not null default '',
  phone text not null default '',
  phone_digits text not null default '',          -- только цифры, для поиска
  tags text[] not null default '{}',
  demands_count int not null default 0,
  demands_sum numeric not null default 0,         -- сумма покупок, тенге
  first_demand_at timestamptz,
  last_demand_at timestamptz,
  bonus_balance numeric not null default 0,       -- всё, что есть у клиента (без сгоревших)
  bonus_available numeric not null default 0,     -- можно списать сейчас (партии старше 14 дней)
  bonus_waiting numeric not null default 0,       -- ждёт активации
  bonus_next_activation date,                     -- когда откроется ближайшая партия
  bonus_expired numeric not null default 0,       -- срок 4 месяца вышел, ещё не списано
  synced_at timestamptz not null default now()
);
create index if not exists kassa_clients_last_demand on public.kassa_clients (last_demand_at desc nulls last);
create index if not exists kassa_clients_phone on public.kassa_clients (phone_digits);
create index if not exists kassa_clients_name on public.kassa_clients (lower(name));
alter table public.kassa_clients enable row level security;
