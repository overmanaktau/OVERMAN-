-- Backs the size breakdown on АВС/XYZ: an "артикул" is now one model+colour
-- (see deriveArticle in lib/moysklad.ts — colour intentionally stays in the
-- derived string, only size/supplier tags get stripped), so everything left
-- varying inside one article is the size. Clicking a row on that page calls
-- this per-article, grouped by the underlying МойСклад product id (= one
-- size), to list what's inside without re-mixing colours back in.

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
  image_url text
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
    max(p.image_url) as image_url
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (p_stores is null or s.store = any(p_stores))
    and s.article = p_article
  group by s.product_ms_id
$$;
