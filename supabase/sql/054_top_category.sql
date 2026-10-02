-- Adds top_category (the root ancestor folder — Верхняя/Плечевая/Брюки/
-- Обувь/Аксессуары, or whatever else sits at the root) alongside the
-- existing leaf-level category, so "Оборачиваемость по категориям" on
-- Обзор can scope to exactly those 5 root folders and everything under
-- them, derived from МойСклад's real folder hierarchy at sync time instead
-- of a hand-maintained list of leaf category strings — which had drifted:
-- a renamed subfolder went unmatched, and "Кэжуал"/"Классика" were wrongly
-- bucketed as Плечевой when МойСклад actually nests them under Брюки.
alter table public.moysklad_products add column if not exists top_category text;
alter table public.moysklad_product_stock add column if not exists top_category text;

drop function if exists public.stock_turnover_by_category(text[], date, date);

create or replace function public.stock_turnover_by_category(p_stores text[], p_from date, p_to date)
returns table (
  category text,
  cogs numeric,
  stock_value numeric,
  revenue numeric,
  stock_sale_value numeric
)
language sql
stable
as $$
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
  stock_agg as (
    select
      coalesce(top_category, 'Без категории') as category,
      sum(stock * buy_price) as stock_value,
      sum(stock * coalesce(sale_price, 0)) as stock_sale_value
    from public.moysklad_product_stock
    where store = any(p_stores)
      and buy_price is not null
      and stock > 0
    group by coalesce(top_category, 'Без категории')
  )
  select
    coalesce(c.category, st.category) as category,
    coalesce(c.cogs, 0) as cogs,
    coalesce(st.stock_value, 0) as stock_value,
    coalesce(c.revenue, 0) as revenue,
    coalesce(st.stock_sale_value, 0) as stock_sale_value
  from cogs_agg c
  full outer join stock_agg st on st.category = c.category
$$;
