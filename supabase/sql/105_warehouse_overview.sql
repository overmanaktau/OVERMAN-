-- Склад → «Обзор»: всё в одном месте за выбранный период и склады.
--   по категориям — уже есть stock_turnover_by_category (продажи, средний остаток, остаток на конец периода);
--   по поставщикам  — warehouse_overview_by_supplier: продано (выручка, себестоимость, штуки), средний остаток и остаток на конец периода;
--   по складам      — warehouse_overview_by_store: то же самое по каждому складу.
-- Остаток на конец периода — по факту, как в МойСклад: если период включает сегодня — живой остаток из таблиц, иначе снимок последнего дня периода.
-- Оборачиваемость считается по СРЕДНЕМУ остатку за период (себестоимость продаж ÷ средний остаток), как в «Обзоре».

drop function if exists public.warehouse_overview_by_supplier(text[], date, date);
create function public.warehouse_overview_by_supplier(p_stores text[], p_from date, p_to date)
returns table(supplier_name text, revenue numeric, cogs numeric, quantity numeric, stock_value numeric, stock_value_end numeric)
language sql
stable
as $$
  with sales as (
    select coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name,
           sum(s.revenue) as revenue, sum(s.cost) as cogs, sum(s.quantity) as quantity
    from public.moysklad_product_sales_daily s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.sale_date between p_from and p_to and s.store = any(p_stores)
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
  live as (
    select coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name,
           sum(s.stock * coalesce(s.buy_price, 0)) as stock_value
    from public.moysklad_product_stock s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.stock > 0 and s.store = any(p_stores)
    group by 1
  ),
  last_snap as (
    select sn.supplier as supplier_name, sum(sn.stock_value) as stock_value
    from public.moysklad_stock_snapshot_supplier_daily sn
    where sn.store = any(p_stores)
      and sn.snapshot_date = (
        select max(snapshot_date) from public.moysklad_stock_snapshot_supplier_daily
        where store = any(p_stores) and snapshot_date between p_from and p_to
      )
    group by sn.supplier
  ),
  avg_st as (
    select * from snap_agg where (select n from snap_days) > 0
    union all
    select * from live where (select n from snap_days) = 0
  ),
  end_st as (
    select * from live where p_to >= public.almaty_today()
    union all
    select * from last_snap where p_to < public.almaty_today()
  )
  select coalesce(s.supplier_name, a.supplier_name, e.supplier_name),
         coalesce(s.revenue, 0), coalesce(s.cogs, 0), coalesce(s.quantity, 0),
         coalesce(a.stock_value, 0), coalesce(e.stock_value, 0)
  from sales s
  full outer join avg_st a on a.supplier_name = s.supplier_name
  full outer join end_st e on e.supplier_name = coalesce(s.supplier_name, a.supplier_name)
$$;

drop function if exists public.warehouse_overview_by_store(text[], date, date);
create function public.warehouse_overview_by_store(p_stores text[], p_from date, p_to date)
returns table(store text, revenue numeric, cogs numeric, quantity numeric, stock_value numeric, stock_value_end numeric)
language sql
stable
as $$
  with sales as (
    select s.store, sum(s.revenue) as revenue, sum(s.cost) as cogs, sum(s.quantity) as quantity
    from public.moysklad_product_sales_daily s
    where s.sale_date between p_from and p_to and s.store = any(p_stores)
    group by s.store
  ),
  snap_days as (
    select count(distinct snapshot_date)::int as n
    from public.moysklad_stock_snapshot_daily
    where store = any(p_stores) and snapshot_date between p_from and p_to
  ),
  snap_agg as (
    select sn.store, sum(sn.stock_value) / nullif((select n from snap_days), 0) as stock_value
    from public.moysklad_stock_snapshot_daily sn
    where sn.store = any(p_stores) and sn.snapshot_date between p_from and p_to
    group by sn.store
  ),
  live as (
    select s.store, sum(s.stock * coalesce(s.buy_price, 0)) as stock_value
    from public.moysklad_product_stock s
    where s.stock > 0 and s.store = any(p_stores)
    group by s.store
  ),
  last_snap as (
    select sn.store, sum(sn.stock_value) as stock_value
    from public.moysklad_stock_snapshot_daily sn
    where sn.store = any(p_stores)
      and sn.snapshot_date = (
        select max(snapshot_date) from public.moysklad_stock_snapshot_daily
        where store = any(p_stores) and snapshot_date between p_from and p_to
      )
    group by sn.store
  ),
  avg_st as (
    select * from snap_agg where (select n from snap_days) > 0
    union all
    select * from live where (select n from snap_days) = 0
  ),
  end_st as (
    select * from live where p_to >= public.almaty_today()
    union all
    select * from last_snap where p_to < public.almaty_today()
  )
  select coalesce(s.store, a.store, e.store),
         coalesce(s.revenue, 0), coalesce(s.cogs, 0), coalesce(s.quantity, 0),
         coalesce(a.stock_value, 0), coalesce(e.stock_value, 0)
  from sales s
  full outer join avg_st a on a.store = s.store
  full outer join end_st e on e.store = coalesce(s.store, a.store)
$$;

grant execute on function public.warehouse_overview_by_supplier(text[], date, date) to authenticated;
grant execute on function public.warehouse_overview_by_store(text[], date, date) to authenticated;
