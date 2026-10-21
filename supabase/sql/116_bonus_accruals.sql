-- Начисление бонусов силами портала (решение владельца 21.10.2026): МойСклад начисляет сразу и не умеет «через 14 дней», поэтому после перехода
-- начисление в программе «5% OVER» отключено, а бонус за покупку портал зачисляет в МойСклад сам, когда проходит срок активации.
-- Одна строка — один чек: amount — сколько должно быть начислено сейчас (5% от суммы чека за вычетом возвратов, вниз), credited — сколько уже зачислено.
create table if not exists public.bonus_accruals (
  demand_id text primary key,             -- id чека (retaildemand) в МойСклад
  client_ms_id text not null,
  demand_name text,
  purchase_at timestamptz not null,
  purchase_date date not null,            -- дата покупки по Алматы
  net_sum numeric not null default 0,     -- сумма чека за вычетом возвратов, ₸
  amount integer not null default 0,
  credited integer not null default 0,
  activates_on date not null,             -- покупка + 14 дней
  tx_id text,                             -- последняя операция в МойСклад
  credited_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists bonus_accruals_client on public.bonus_accruals (client_ms_id);
create index if not exists bonus_accruals_due on public.bonus_accruals (activates_on) where credited <> amount;
alter table public.bonus_accruals enable row level security;

-- С какого момента (покупки) бонус начисляет портал; пока пусто — ничего не происходит, начисляет сам МойСклад.
alter table public.moysklad_sync_state add column if not exists accrual_start timestamptz;
