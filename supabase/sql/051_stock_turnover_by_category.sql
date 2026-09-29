-- Per-category breakdown for "Оборачиваемость склада" on Обзор — a single
-- weighted-average figure hides that "верх"/"низ"/etc turn over at very
-- different rates. Same weighting as stock_turnover_days (050): each
-- category's days-figure is weighted by money tied up (stock × cost), not a
-- plain per-SKU average. Runs with the caller's own privileges, so
-- moysklad_product_stock's own RLS (has_access('warehouse.stock', 'view'))
-- still applies exactly as if the caller had queried it directly.
create or replace function public.stock_turnover_by_category(p_stores text[])
returns table (
  category text,
  turnover_days numeric,
  stock_value numeric,
  stock_units numeric
)
language sql
stable
as $$
  select
    coalesce(category, 'Без категории') as category,
    sum(stock_days * stock * buy_price) / nullif(sum(stock * buy_price), 0) as turnover_days,
    sum(stock * buy_price) as stock_value,
    sum(stock) as stock_units
  from public.moysklad_product_stock
  where store = any(p_stores)
    and stock_days is not null
    and buy_price is not null
    and stock > 0
  group by coalesce(category, 'Без категории')
  order by stock_value desc
$$;
