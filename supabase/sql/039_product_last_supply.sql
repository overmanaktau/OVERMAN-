-- "Зависшие остатки" was flagging a product the moment it had zero sales in
-- the window, even if it was physically just delivered and hasn't had a
-- chance to sell yet. This tracks the last known приёмка (goods-received)
-- date per product/склад, straight from МойСклад's entity/supply — a
-- product restocked within the staleness window gets a grace period, same
-- as one that actually sold recently. A product with no supply record here
-- at all (older stock than our tracking, or received some other way) falls
-- back to the old sale-only rule — this only ever gives extra benefit of
-- the doubt, never makes something newly stale.

create table if not exists public.moysklad_product_last_supply (
  product_ms_id text not null,
  store text not null,
  last_supply_date date not null,
  synced_at timestamptz not null default now(),
  primary key (product_ms_id, store)
);

alter table public.moysklad_product_last_supply enable row level security;

do $$
declare pol record;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename = 'moysklad_product_last_supply'
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

create policy moysklad_product_last_supply_select on public.moysklad_product_last_supply
  for select using (public.has_access('warehouse.stock', 'view'));

-- Same signature as before (037) — a genuine replace, not a new overload.
create or replace function public.stale_inventory(p_stale_days int, p_stores text[] default null)
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
    sum(s.stock) as stock,
    sum(s.stock * coalesce(s.buy_price, 0)) as money,
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
