-- Оборачиваемость по среднему остатку. Раньше: себестоимость проданного за период ÷
-- себестоимость остатка НА СЕГОДНЯ. Теперь: ÷ средняя за период себестоимость остатка по
-- ежедневным снимкам (moysklad_stock_snapshot_daily). Если за выбранный период снимков нет —
-- по-прежнему остаток на сегодня.
--
-- Снимок — на конец дня, по складу и верхней категории товара: себестоимость остатка и
-- розничная стоимость остатка. Пишет только сервер (service role): ночная синхронизация и
-- восстановление истории; читает тот, у кого есть доступ к разделу «Склад → остатки».

create table if not exists public.moysklad_stock_snapshot_daily (
  snapshot_date date not null,
  store text not null,
  top_category text not null default 'Без категории',
  stock_value numeric not null default 0,
  stock_sale_value numeric not null default 0,
  items numeric not null default 0,
  primary key (snapshot_date, store, top_category)
);

alter table public.moysklad_stock_snapshot_daily enable row level security;

drop policy if exists moysklad_stock_snapshot_daily_select on public.moysklad_stock_snapshot_daily;
create policy moysklad_stock_snapshot_daily_select on public.moysklad_stock_snapshot_daily
  for select using (public.has_access('warehouse.stock', 'view'));

create or replace function public.stock_turnover_by_category(p_stores text[], p_from date, p_to date)
returns table(category text, cogs numeric, stock_value numeric, revenue numeric, stock_sale_value numeric)
language sql
stable
as $function$
  with cogs_agg as (
    select
      coalesce(p.top_category, 'Без категории') as category,
      sum(s.cost) as cogs,
      sum(s.revenue) as revenue
    from public.moysklad_product_sales_daily s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.sale_date between p_from and p_to
      and s.store = any(p_stores)
    group by coalesce(p.top_category, 'Без категории')
  ),
  snap_days as (
    select count(distinct snapshot_date) as n
    from public.moysklad_stock_snapshot_daily
    where store = any(p_stores) and snapshot_date between p_from and p_to
  ),
  -- Средний остаток за период: сумма по дням со снимком ÷ число таких дней.
  snap_agg as (
    select
      sn.top_category as category,
      sum(sn.stock_value) / nullif((select n from snap_days), 0) as stock_value,
      sum(sn.stock_sale_value) / nullif((select n from snap_days), 0) as stock_sale_value
    from public.moysklad_stock_snapshot_daily sn
    where sn.store = any(p_stores) and sn.snapshot_date between p_from and p_to
    group by sn.top_category
  ),
  -- Запасной вариант, если снимков за период нет: остаток на сегодня.
  current_agg as (
    select
      coalesce(top_category, 'Без категории') as category,
      sum(stock * buy_price) as stock_value,
      sum(stock * coalesce(sale_price, 0)) as stock_sale_value
    from public.moysklad_product_stock
    where store = any(p_stores)
      and buy_price is not null
      and stock > 0
    group by coalesce(top_category, 'Без категории')
  ),
  stock_agg as (
    select * from snap_agg where (select n from snap_days) > 0
    union all
    select * from current_agg where (select n from snap_days) = 0
  )
  select
    coalesce(c.category, st.category) as category,
    coalesce(c.cogs, 0) as cogs,
    coalesce(st.stock_value, 0) as stock_value,
    coalesce(c.revenue, 0) as revenue,
    coalesce(st.stock_sale_value, 0) as stock_sale_value
  from cogs_agg c
  full outer join stock_agg st on st.category = c.category
$function$;
