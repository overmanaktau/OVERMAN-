-- Остатки как в МойСклад: итоги по складам, по поставщикам и список товаров поставщика считаются так же, как в отчёте «Остатки»
-- МойСклад по складу — с учётом минусовых остатков (в отчёте они вычитаются из итога штук и суммы продажи, себестоимость у них 0).
-- Минусовые позиции лежат в отдельной таблице: основная таблица остатков (moysklad_product_stock) остаётся только с плюсовыми,
-- на ней держатся «Зависшие остатки», оборачиваемость и разбивка приходов по партиям — им минусы не нужны.
create table if not exists public.moysklad_product_stock_negative (
  product_ms_id text not null,
  store text not null,
  product_name text,
  stock numeric not null,           -- отрицательное
  sale_price numeric,
  synced_at timestamptz not null default now(),
  primary key (product_ms_id, store)
);
alter table public.moysklad_product_stock_negative enable row level security;
drop policy if exists moysklad_product_stock_negative_select on public.moysklad_product_stock_negative;
create policy moysklad_product_stock_negative_select on public.moysklad_product_stock_negative
  for select using ((select public.has_access('warehouse.stock', 'view')));

create or replace function public.stock_warehouses()
returns table(store text, skus integer, stock numeric, money numeric)
language sql
stable
as $$
  select t.store,
         count(distinct t.product_ms_id)::int as skus,
         sum(t.stock) as stock,
         sum(t.money) as money
  from (
    select s.store, s.product_ms_id, s.stock, s.stock * coalesce(s.buy_price, 0) as money
    from public.moysklad_product_stock s
    where s.stock > 0
    union all
    select n.store, n.product_ms_id, n.stock, 0::numeric as money
    from public.moysklad_product_stock_negative n
  ) t
  group by t.store
$$;

create or replace function public.stock_by_supplier(p_stores text[] default null)
returns table(supplier_name text, skus integer, articles integer, stock numeric, money numeric, sale_value numeric)
language sql
stable
as $$
  select
    coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name,
    count(distinct t.product_ms_id)::int as skus,
    count(distinct coalesce(p.article, t.product_name))::int as articles,
    sum(t.stock) as stock,
    sum(t.stock * coalesce(t.buy_price, 0)) as money,
    sum(t.stock * coalesce(t.sale_price, 0)) as sale_value
  from (
    select s.product_ms_id, s.product_name, s.store, s.stock, s.buy_price, s.sale_price
    from public.moysklad_product_stock s
    where s.stock > 0
    union all
    select n.product_ms_id, n.product_name, n.store, n.stock, 0::numeric, n.sale_price
    from public.moysklad_product_stock_negative n
  ) t
  left join public.moysklad_products p on p.id = t.product_ms_id
  where (p_stores is null or t.store = any(p_stores))
  group by 1
$$;

create or replace function public.stock_by_supplier_items(p_stores text[] default null, p_supplier text default null)
returns table(product_ms_id text, product_name text, article text, stock numeric, buy_price numeric, money numeric, sale_value numeric)
language sql
stable
as $$
  select
    t.product_ms_id,
    max(t.product_name) as product_name,
    max(coalesce(p.article, t.product_name)) as article,
    sum(t.stock) as stock,
    max(t.buy_price) as buy_price,
    sum(t.stock * coalesce(t.buy_price, 0)) as money,
    sum(t.stock * coalesce(t.sale_price, 0)) as sale_value
  from (
    select s.product_ms_id, s.product_name, s.store, s.stock, s.buy_price, s.sale_price
    from public.moysklad_product_stock s
    where s.stock > 0
    union all
    select n.product_ms_id, n.product_name, n.store, n.stock, 0::numeric, n.sale_price
    from public.moysklad_product_stock_negative n
  ) t
  left join public.moysklad_products p on p.id = t.product_ms_id
  where (p_stores is null or t.store = any(p_stores))
    and coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') = p_supplier
  group by t.product_ms_id
$$;
