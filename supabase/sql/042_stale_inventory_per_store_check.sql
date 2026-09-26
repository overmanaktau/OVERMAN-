-- Bug: last-sale (and last-supply) checks were grouped by product_ms_id
-- ALONE, blending every selected city's sales together — so stock sitting
-- dead in Aktau could get excused from "Зависшие остатки" just because the
-- same article happened to sell recently in Aktobe, even though that
-- specific Aktau stock never moved. Turning on a second city could then
-- shrink the total instead of only ever growing it (confirmed live: adding
-- Актобе to Актау lowered the count).
--
-- Fix: test staleness per (product, склад) row — a склad's own stock only
-- gets excused by that SAME склад's own sale/supply history — then sum
-- only the rows that are independently stale. Adding a city to the filter
-- can now only add qualifying rows, never remove one that already qualified.

create or replace function public.stale_inventory(p_stale_days int, p_stores text[] default null)
returns table (
  product_ms_id text,
  product_name text,
  stock numeric,
  money numeric,
  sale_value numeric,
  days_since_last_sale integer
)
language sql
stable
as $$
  with per_store_sale as (
    select product_ms_id, store, max(sale_date) as last_sale_date
    from public.moysklad_product_sales_daily
    where quantity > 0
    group by product_ms_id, store
  )
  select
    s.product_ms_id,
    s.product_name,
    sum(s.stock) as stock,
    sum(s.stock * coalesce(s.buy_price, 0)) as money,
    sum(s.stock * coalesce(s.sale_price, 0)) as sale_value,
    max(current_date - ls.last_sale_date) as days_since_last_sale
  from public.moysklad_product_stock s
  left join per_store_sale ls
    on ls.product_ms_id = s.product_ms_id and ls.store = s.store
  left join public.moysklad_product_last_supply sup
    on sup.product_ms_id = s.product_ms_id and sup.store = s.store
  where s.stock > 0
    and (p_stores is null or s.store = any(p_stores))
    and (ls.last_sale_date is null or (current_date - ls.last_sale_date) > p_stale_days)
    and (sup.last_supply_date is null or (current_date - sup.last_supply_date) > p_stale_days)
  group by s.product_ms_id, s.product_name
$$;
