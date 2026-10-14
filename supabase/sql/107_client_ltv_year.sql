-- Годовой LTV по городам (страница «Продажа»): сколько чеков и разных клиентов было за последние 365 дней.
-- Пересчитывается каждую ночь серверным маршрутом /api/moysklad/ltv-year; средняя частота покупок = purchases ÷ clients.
create table if not exists public.client_ltv_year (
  store text primary key, -- город: point_1 / point_3
  period_from date not null,
  period_to date not null,
  clients integer not null default 0,
  purchases integer not null default 0,
  computed_at timestamptz not null default now()
);
alter table public.client_ltv_year enable row level security;
drop policy if exists client_ltv_year_select on public.client_ltv_year;
create policy client_ltv_year_select on public.client_ltv_year
  for select using ((select public.has_access('marketing.statistics', 'view')));
