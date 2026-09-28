-- Two things bundled together:
--
-- 1. Full-resolution photos. moysklad_products.image_url only ever held the
--    small "miniature" thumbnail (МойСклад serves that one without auth).
--    The original photo lives behind a download link that DOES need our
--    API token (confirmed live: 401 unauthenticated, 200 with Bearer) — so
--    the app proxies it server-side (app/api/moysklad/image) rather than
--    exposing the token to the browser. image_full_href stores that
--    authenticated download link for the proxy to fetch.
--
-- 2. Зависшие остатки grouped by article, same as АВС/XYZ. It used to list
--    every colour/size SKU as its own row; now it groups by article (model
--    + colour — see deriveArticle in lib/moysklad.ts) with a per-size
--    breakdown behind an expand, via stale_inventory_by_sku. The shared
--    staleness logic (per product+store, unchanged from migration 042)
--    moves into a view so both functions read it once instead of
--    duplicating the joins.

alter table public.moysklad_products add column if not exists article text;
alter table public.moysklad_products add column if not exists image_full_href text;

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
    sup.last_supply_date
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

drop function if exists public.stale_inventory(int, text[]);

create or replace function public.stale_inventory(p_stale_days int, p_stores text[] default null)
returns table (
  article text,
  stock numeric,
  money numeric,
  sale_value numeric,
  days_since_last_sale integer,
  image_url text,
  image_full_href text
)
language sql
stable
as $$
  select
    article,
    sum(stock) as stock,
    sum(money) as money,
    sum(sale_value) as sale_value,
    max(current_date - last_sale_date) as days_since_last_sale,
    max(image_url) as image_url,
    max(image_full_href) as image_full_href
  from public._stale_stock_rows
  where (p_stores is null or store = any(p_stores))
    and (last_sale_date is null or (current_date - last_sale_date) > p_stale_days)
    and (last_supply_date is null or (current_date - last_supply_date) > p_stale_days)
  group by article
$$;

create or replace function public.stale_inventory_by_sku(p_stale_days int, p_stores text[] default null, p_article text default null)
returns table (
  product_ms_id text,
  product_name text,
  stock numeric,
  money numeric,
  sale_value numeric,
  days_since_last_sale integer,
  image_url text,
  image_full_href text
)
language sql
stable
as $$
  select
    product_ms_id,
    max(product_name) as product_name,
    sum(stock) as stock,
    sum(money) as money,
    sum(sale_value) as sale_value,
    max(current_date - last_sale_date) as days_since_last_sale,
    max(image_url) as image_url,
    max(image_full_href) as image_full_href
  from public._stale_stock_rows
  where (p_stores is null or store = any(p_stores))
    and (last_sale_date is null or (current_date - last_sale_date) > p_stale_days)
    and (last_supply_date is null or (current_date - last_supply_date) > p_stale_days)
    and article = p_article
  group by product_ms_id
$$;

drop function if exists public.product_sales_summary_by_article(date, date, text[]);

create or replace function public.product_sales_summary_by_article(p_from date, p_to date, p_stores text[] default null)
returns table (
  article text,
  category text,
  revenue numeric,
  quantity numeric,
  cost numeric,
  days_with_sales integer,
  image_url text,
  image_full_href text
)
language sql
stable
as $$
  select
    s.article,
    max(p.category) as category,
    sum(s.revenue) as revenue,
    sum(s.quantity) as quantity,
    sum(s.cost) as cost,
    count(distinct s.sale_date) filter (where s.quantity > 0)::int as days_with_sales,
    max(p.image_url) as image_url,
    max(p.image_full_href) as image_full_href
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (p_stores is null or s.store = any(p_stores))
    and s.article is not null
  group by s.article
$$;

drop function if exists public.product_sales_summary_by_sku(date, date, text[], text);

create or replace function public.product_sales_summary_by_sku(
  p_from date,
  p_to date,
  p_stores text[] default null,
  p_article text default null
)
returns table (
  product_ms_id text,
  product_name text,
  revenue numeric,
  quantity numeric,
  cost numeric,
  days_with_sales integer,
  image_url text,
  image_full_href text
)
language sql
stable
as $$
  select
    s.product_ms_id,
    max(s.product_name) as product_name,
    sum(s.revenue) as revenue,
    sum(s.quantity) as quantity,
    sum(s.cost) as cost,
    count(distinct s.sale_date) filter (where s.quantity > 0)::int as days_with_sales,
    max(p.image_url) as image_url,
    max(p.image_full_href) as image_full_href
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (p_stores is null or s.store = any(p_stores))
    and s.article = p_article
  group by s.product_ms_id
$$;
