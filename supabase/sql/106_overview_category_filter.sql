-- Склад → «Обзор»: галочки у категорий действуют и на таблицы «По поставщикам» и «По складам».
-- Для этого функции получают список исключённых категорий (p_exclude — верхние категории каталога, как их хранит база), а снимок остатков
-- по поставщикам теперь хранится ещё и в разрезе верхней категории (средний остаток и остаток на конец периода считаются без выключенных категорий).
-- Строки снимков, записанные до этой миграции, получают категорию «Без категории» и обновятся при пересборке истории.

alter table public.moysklad_stock_snapshot_supplier_daily add column if not exists top_category text not null default 'Без категории';
alter table public.moysklad_stock_snapshot_supplier_daily drop constraint if exists moysklad_stock_snapshot_supplier_daily_pkey;
alter table public.moysklad_stock_snapshot_supplier_daily add primary key (snapshot_date, store, supplier, top_category);

drop function if exists public.warehouse_overview_by_supplier(text[], date, date);
drop function if exists public.warehouse_overview_by_supplier(text[], date, date, text[]);
create function public.warehouse_overview_by_supplier(p_stores text[], p_from date, p_to date, p_exclude text[] default '{}')
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
      and not (coalesce(p.top_category, 'Без категории') = any(p_exclude))
    group by 1
  ),
  snap_days as (
    select count(distinct snapshot_date)::int as n
    from public.moysklad_stock_snapshot_supplier_daily
    where store = any(p_stores) and snapshot_date between p_from and p_to
      and not (top_category = any(p_exclude))
  ),
  snap_agg as (
    select sn.supplier as supplier_name, sum(sn.stock_value) / nullif((select n from snap_days), 0) as stock_value
    from public.moysklad_stock_snapshot_supplier_daily sn
    where sn.store = any(p_stores) and sn.snapshot_date between p_from and p_to
      and not (sn.top_category = any(p_exclude))
    group by sn.supplier
  ),
  live as (
    select coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name,
           sum(s.stock * coalesce(s.buy_price, 0)) as stock_value
    from public.moysklad_product_stock s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.stock > 0 and s.store = any(p_stores)
      and not (coalesce(s.top_category, 'Без категории') = any(p_exclude))
    group by 1
  ),
  last_snap as (
    select sn.supplier as supplier_name, sum(sn.stock_value) as stock_value
    from public.moysklad_stock_snapshot_supplier_daily sn
    where sn.store = any(p_stores)
      and not (sn.top_category = any(p_exclude))
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
drop function if exists public.warehouse_overview_by_store(text[], date, date, text[]);
create function public.warehouse_overview_by_store(p_stores text[], p_from date, p_to date, p_exclude text[] default '{}')
returns table(store text, revenue numeric, cogs numeric, quantity numeric, stock_value numeric, stock_value_end numeric)
language sql
stable
as $$
  with sales as (
    select s.store, sum(s.revenue) as revenue, sum(s.cost) as cogs, sum(s.quantity) as quantity
    from public.moysklad_product_sales_daily s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.sale_date between p_from and p_to and s.store = any(p_stores)
      and not (coalesce(p.top_category, 'Без категории') = any(p_exclude))
    group by s.store
  ),
  snap_days as (
    select count(distinct snapshot_date)::int as n
    from public.moysklad_stock_snapshot_daily
    where store = any(p_stores) and snapshot_date between p_from and p_to
      and not (top_category = any(p_exclude))
  ),
  snap_agg as (
    select sn.store, sum(sn.stock_value) / nullif((select n from snap_days), 0) as stock_value
    from public.moysklad_stock_snapshot_daily sn
    where sn.store = any(p_stores) and sn.snapshot_date between p_from and p_to
      and not (sn.top_category = any(p_exclude))
    group by sn.store
  ),
  live as (
    select s.store, sum(s.stock * coalesce(s.buy_price, 0)) as stock_value
    from public.moysklad_product_stock s
    where s.stock > 0 and s.store = any(p_stores)
      and not (coalesce(s.top_category, 'Без категории') = any(p_exclude))
    group by s.store
  ),
  last_snap as (
    select sn.store, sum(sn.stock_value) as stock_value
    from public.moysklad_stock_snapshot_daily sn
    where sn.store = any(p_stores)
      and not (sn.top_category = any(p_exclude))
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

grant execute on function public.warehouse_overview_by_supplier(text[], date, date, text[]) to authenticated;
grant execute on function public.warehouse_overview_by_store(text[], date, date, text[]) to authenticated;
