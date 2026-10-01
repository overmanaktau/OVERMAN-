-- Adds продано/остаток by sale price alongside the existing cost-price
-- figures on "Оборачиваемость по категориям" (Обзор) — same breakdown,
-- just also showing what the sold/stock amounts are at retail price
-- (moysklad_product_sales_daily.revenue, moysklad_product_stock.sale_price)
-- next to the себестоимость ones the % is actually computed from.
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
      coalesce(p.category, 'Без категории') as category,
      sum(s.cost) as cogs,
      sum(s.revenue) as revenue
    from public.moysklad_product_sales_daily s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.sale_date between p_from and p_to
      and s.store = any(p_stores)
    group by coalesce(p.category, 'Без категории')
  ),
  stock_agg as (
    select
      coalesce(category, 'Без категории') as category,
      sum(stock * buy_price) as stock_value,
      sum(stock * coalesce(sale_price, 0)) as stock_sale_value
    from public.moysklad_product_stock
    where store = any(p_stores)
      and buy_price is not null
      and stock > 0
    group by coalesce(category, 'Без категории')
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
