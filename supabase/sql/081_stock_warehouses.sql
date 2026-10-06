-- Склады, на которых сейчас реально есть товар — чтобы в фильтрах не показывать пустые.
create or replace function public.stock_warehouses()
returns table (store text, skus integer, stock numeric, money numeric)
language sql
stable
as $$
  select
    s.store,
    count(distinct s.product_ms_id)::int as skus,
    sum(s.stock) as stock,
    sum(s.stock * coalesce(s.buy_price, 0)) as money
  from public.moysklad_product_stock s
  where s.stock > 0
  group by s.store
$$;
