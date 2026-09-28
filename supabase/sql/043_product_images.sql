-- Product photos, straight from МойСклад's /report/stock/all (the same
-- report Зависшие остатки already syncs stock from) — the miniature/tiny
-- URLs it returns load with no Authorization header (confirmed live), so
-- the page can use them directly as <img src>, no proxying needed.
-- Coverage is real but partial: only ~14% of currently-stocked products had
-- a photo uploaded when this was added — the rest just render with none.

alter table public.moysklad_products add column if not exists image_url text;

drop function if exists public.stale_inventory(int, text[]);

create or replace function public.stale_inventory(p_stale_days int, p_stores text[] default null)
returns table (
  product_ms_id text,
  product_name text,
  stock numeric,
  money numeric,
  sale_value numeric,
  days_since_last_sale integer,
  image_url text
)
language sql
stable
as $$
  select
    s.product_ms_id,
    s.product_name,
    sum(s.stock) as stock,
    sum(s.stock * coalesce(s.buy_price, 0)) as money,
    sum(s.stock * coalesce(s.sale_price, 0)) as sale_value,
    max(current_date - ls.last_sale_date) as days_since_last_sale,
    max(p.image_url) as image_url
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
  where s.stock > 0
    and (p_stores is null or s.store = any(p_stores))
    and (ls.last_sale_date is null or (current_date - ls.last_sale_date) > p_stale_days)
    and (sup.last_supply_date is null or (current_date - sup.last_supply_date) > p_stale_days)
  group by s.product_ms_id, s.product_name
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
  image_url text
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
    max(p.image_url) as image_url
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (p_stores is null or s.store = any(p_stores))
    and s.article is not null
  group by s.article
$$;
