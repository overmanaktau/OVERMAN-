-- Склад → «По поставщикам»: остатки и зависшие остатки в разрезе поставщика.
-- Поставщик берётся из карточки товара в МойСклад (поле «Поставщик»); его
-- подтягивает ночная синхронизация каталога. Товар без поставщика — «Без поставщика».

alter table public.moysklad_products add column if not exists supplier text;

-- Общая выборка зависших остатков получает поставщика (колонка в конец —
-- существующие запросы не ломаются).
create or replace view public._stale_stock_rows as
  select
    s.product_ms_id,
    s.product_name,
    s.store,
    coalesce(p.article, s.product_name) as article,
    s.stock,
    s.stock * coalesce(s.buy_price, 0) as money,
    s.stock * coalesce(s.sale_price, 0) as sale_value,
    p.image_url,
    p.image_full_href,
    ls.last_sale_date,
    sup.last_supply_date,
    coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name
  from public.moysklad_product_stock s
  left join public.moysklad_products p on p.id = s.product_ms_id
  left join (
    select product_ms_id, store, max(sale_date) as last_sale_date
    from public.moysklad_product_sales_daily
    where quantity > 0
    group by product_ms_id, store
  ) ls on ls.product_ms_id = s.product_ms_id and ls.store = s.store
  left join public.moysklad_product_last_supply sup
    on sup.product_ms_id = s.product_ms_id and sup.store = s.store
  where s.stock > 0;

-- Остатки по поставщикам: сколько артикулов, штук и денег (по себестоимости)
create or replace function public.stock_by_supplier(p_stores text[] default null)
returns table (
  supplier_name text,
  skus integer,
  articles integer,
  stock numeric,
  money numeric,
  sale_value numeric
)
language sql
stable
as $$
  select
    coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name,
    count(distinct s.product_ms_id)::int as skus,
    count(distinct coalesce(p.article, s.product_name))::int as articles,
    sum(s.stock) as stock,
    sum(s.stock * coalesce(s.buy_price, 0)) as money,
    sum(s.stock * coalesce(s.sale_price, 0)) as sale_value
  from public.moysklad_product_stock s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.stock > 0
    and (p_stores is null or s.store = any(p_stores))
  group by 1
$$;

-- Товары одного поставщика (по одному ряду на товар/размер)
create or replace function public.stock_by_supplier_items(p_stores text[] default null, p_supplier text default null)
returns table (
  product_ms_id text,
  product_name text,
  article text,
  stock numeric,
  buy_price numeric,
  money numeric,
  sale_value numeric
)
language sql
stable
as $$
  select
    s.product_ms_id,
    max(s.product_name) as product_name,
    max(coalesce(p.article, s.product_name)) as article,
    sum(s.stock) as stock,
    max(s.buy_price) as buy_price,
    sum(s.stock * coalesce(s.buy_price, 0)) as money,
    sum(s.stock * coalesce(s.sale_price, 0)) as sale_value
  from public.moysklad_product_stock s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.stock > 0
    and (p_stores is null or s.store = any(p_stores))
    and coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') = p_supplier
  group by s.product_ms_id
$$;

-- Зависшие остатки по поставщикам (то же правило зависания, что и в «Зависших остатках»)
create or replace function public.stale_by_supplier(p_stale_days int, p_stores text[] default null)
returns table (
  supplier_name text,
  skus integer,
  articles integer,
  stock numeric,
  money numeric,
  sale_value numeric,
  max_days integer
)
language sql
stable
as $$
  select
    supplier_name,
    count(distinct product_ms_id)::int as skus,
    count(distinct article)::int as articles,
    sum(stock) as stock,
    sum(money) as money,
    sum(sale_value) as sale_value,
    max(current_date - last_sale_date) as max_days
  from public._stale_stock_rows
  where (p_stores is null or store = any(p_stores))
    and (last_sale_date is null or (current_date - last_sale_date) > p_stale_days)
    and (last_supply_date is null or (current_date - last_supply_date) > p_stale_days)
  group by supplier_name
$$;

create or replace function public.stale_by_supplier_items(p_stale_days int, p_stores text[] default null, p_supplier text default null)
returns table (
  product_ms_id text,
  product_name text,
  article text,
  stock numeric,
  money numeric,
  sale_value numeric,
  days_since_last_sale integer
)
language sql
stable
as $$
  select
    product_ms_id,
    max(product_name) as product_name,
    max(article) as article,
    sum(stock) as stock,
    sum(money) as money,
    sum(sale_value) as sale_value,
    max(current_date - last_sale_date) as days_since_last_sale
  from public._stale_stock_rows
  where (p_stores is null or store = any(p_stores))
    and (last_sale_date is null or (current_date - last_sale_date) > p_stale_days)
    and (last_supply_date is null or (current_date - last_supply_date) > p_stale_days)
    and supplier_name = p_supplier
  group by product_ms_id
$$;
