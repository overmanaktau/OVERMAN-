-- "Зависшие остатки" was filtering on МойСклад's own "stockDays" (a
-- turnover/days-of-supply estimate), which doesn't mean "hasn't sold in N
-- days" — a low-stock item can show a small stockDays even after months
-- without a sale. What the page actually needs is a real days-since-last-
-- sale per product, computed from our own synced history, so products that
-- genuinely had zero sales in that window are the ones that show up.

create or replace function public.stale_inventory(p_stale_days int)
returns table (
  product_ms_id text,
  product_name text,
  stock numeric,
  money numeric,
  days_since_last_sale integer
)
language sql
stable
as $$
  select
    s.product_ms_id,
    s.product_name,
    s.stock,
    s.stock * coalesce(s.buy_price, 0) as money,
    (current_date - ls.last_sale_date)::int as days_since_last_sale
  from public.moysklad_product_stock s
  left join (
    select product_ms_id, max(sale_date) as last_sale_date
    from public.moysklad_product_sales_daily
    where quantity > 0
    group by product_ms_id
  ) ls on ls.product_ms_id = s.product_ms_id
  where s.stock > 0
    and (ls.last_sale_date is null or (current_date - ls.last_sale_date) > p_stale_days)
$$;
