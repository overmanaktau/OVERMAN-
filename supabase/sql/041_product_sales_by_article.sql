-- АВС/XYZ at the individual size/colour level is nearly meaningless here —
-- МойСклад has no working "артикул" field for this account (every colour
-- and size is its own top-level product, confirmed live), so the app
-- derives a shared "артикул" from the product name in JS (lib/moysklad.ts,
-- deriveArticle) and stores it per sales row, computed once at sync time
-- rather than re-parsed on every query.

alter table public.moysklad_product_sales_daily add column if not exists article text;

create index if not exists moysklad_product_sales_daily_article_idx
  on public.moysklad_product_sales_daily (article);

create or replace function public.product_sales_summary_by_article(p_from date, p_to date, p_stores text[] default null)
returns table (
  article text,
  category text,
  revenue numeric,
  quantity numeric,
  cost numeric,
  days_with_sales integer
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
    count(distinct s.sale_date) filter (where s.quantity > 0)::int as days_with_sales
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (p_stores is null or s.store = any(p_stores))
    and s.article is not null
  group by s.article
$$;
