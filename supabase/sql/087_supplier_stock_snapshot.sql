-- Оборачиваемость по поставщикам считается по СРЕДНЕМУ остатку за период — так же, как в «Обзоре».
-- Для этого ежедневный снимок остатков теперь хранится ещё и в разрезе поставщика
-- (себестоимость остатка на конец дня по складу и поставщику).
create table if not exists public.moysklad_stock_snapshot_supplier_daily (
  snapshot_date date not null,
  store text not null,
  supplier text not null,
  stock_value numeric not null default 0,
  items numeric not null default 0,
  primary key (snapshot_date, store, supplier)
);

alter table public.moysklad_stock_snapshot_supplier_daily enable row level security;
drop policy if exists moysklad_stock_snapshot_supplier_daily_select on public.moysklad_stock_snapshot_supplier_daily;
create policy moysklad_stock_snapshot_supplier_daily_select on public.moysklad_stock_snapshot_supplier_daily
  for select using (public.has_access('warehouse.stock', 'view'));

-- Оборачиваемость по поставщикам: себестоимость продаж за период и СРЕДНЯЯ себестоимость остатка
-- (сумма по дням со снимком ÷ число таких дней, как stock_turnover_by_category). Если за период
-- снимков нет — остаток на сегодня. snapshot_days показывает, по скольким дням посчитано среднее.
drop function if exists public.stock_turnover_by_supplier(text[], date, date);
create function public.stock_turnover_by_supplier(p_stores text[], p_from date, p_to date)
returns table (supplier_name text, cogs numeric, stock_value numeric, snapshot_days integer)
language sql
stable
as $$
  with c as (
    select coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name, sum(s.cost) as cogs
    from public.moysklad_product_sales_daily s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.sale_date between p_from and p_to
      and s.store = any(p_stores)
    group by 1
  ),
  snap_days as (
    select count(distinct snapshot_date)::int as n
    from public.moysklad_stock_snapshot_supplier_daily
    where store = any(p_stores) and snapshot_date between p_from and p_to
  ),
  snap_agg as (
    select sn.supplier as supplier_name, sum(sn.stock_value) / nullif((select n from snap_days), 0) as stock_value
    from public.moysklad_stock_snapshot_supplier_daily sn
    where sn.store = any(p_stores) and sn.snapshot_date between p_from and p_to
    group by sn.supplier
  ),
  current_agg as (
    select coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name,
           sum(s.stock * coalesce(s.buy_price, 0)) as stock_value
    from public.moysklad_product_stock s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.stock > 0 and s.store = any(p_stores)
    group by 1
  ),
  st as (
    select * from snap_agg where (select n from snap_days) > 0
    union all
    select * from current_agg where (select n from snap_days) = 0
  )
  select coalesce(c.supplier_name, st.supplier_name), coalesce(c.cogs, 0), coalesce(st.stock_value, 0), (select n from snap_days)
  from c full outer join st on st.supplier_name = c.supplier_name
$$;

grant execute on function public.stock_turnover_by_supplier(text[], date, date) to authenticated;
