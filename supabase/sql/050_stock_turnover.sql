-- Оборачиваемость склада for the "Обзор" page: a single weighted-average
-- days-of-stock figure across the selected stores. moysklad_product_stock
-- has thousands of rows (well past PostgREST's default 1000-row page cap),
-- so this aggregates server-side instead of pulling every row to sum
-- client-side — same reasoning as product_sales_summary in 034. Runs with
-- the caller's own privileges, so the table's own RLS (has_access
-- ('warehouse.stock', 'view')) still applies exactly as if the caller had
-- queried it directly.
create or replace function public.stock_turnover_days(p_stores text[])
returns numeric
language sql
stable
as $$
  select case when sum(stock * buy_price) > 0
    then sum(stock_days * stock * buy_price) / sum(stock * buy_price)
    else null end
  from public.moysklad_product_stock
  where store = any(p_stores)
    and stock_days is not null
    and buy_price is not null
    and stock > 0
$$;
