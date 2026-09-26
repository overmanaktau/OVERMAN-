-- "Зависшие остатки" only showed money at cost (buy_price) — adds the
-- retail value (sale_price × stock) alongside it, so it's visible how much
-- this stock would bring in at full price versus what it cost to buy.

alter table public.moysklad_product_stock add column if not exists sale_price numeric;

-- Same argument signature as before, but the OUT columns changed (added
-- sale_value) — Postgres won't let create-or-replace change the return row
-- type, so the old one has to go first.
drop function if exists public.stale_inventory(int, text[]);

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
  select
    s.product_ms_id,
    s.product_name,
    sum(s.stock) as stock,
    sum(s.stock * coalesce(s.buy_price, 0)) as money,
    sum(s.stock * coalesce(s.sale_price, 0)) as sale_value,
    (current_date - ls.last_sale_date)::int as days_since_last_sale
  from public.moysklad_product_stock s
  left join (
    select product_ms_id, max(sale_date) as last_sale_date
    from public.moysklad_product_sales_daily
    where quantity > 0
      and (p_stores is null or store = any(p_stores))
    group by product_ms_id
  ) ls on ls.product_ms_id = s.product_ms_id
  left join (
    select product_ms_id, max(last_supply_date) as last_supply_date
    from public.moysklad_product_last_supply
    where (p_stores is null or store = any(p_stores))
    group by product_ms_id
  ) sup on sup.product_ms_id = s.product_ms_id
  where s.stock > 0
    and (p_stores is null or s.store = any(p_stores))
    and (ls.last_sale_date is null or (current_date - ls.last_sale_date) > p_stale_days)
    and (sup.last_supply_date is null or (current_date - sup.last_supply_date) > p_stale_days)
  group by s.product_ms_id, s.product_name, ls.last_sale_date, sup.last_supply_date
$$;
