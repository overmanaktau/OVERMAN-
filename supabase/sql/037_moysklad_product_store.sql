-- Adds a city/склад dimension to the product stock snapshot and the daily
-- per-product sales, so "Зависшие остатки" and АВС/XYZ can be filtered by
-- the same "Все города" picker every other page already uses. Values:
-- 'point_1' / 'point_3' (matches public.stores.code — no FK here on
-- purpose, see below) or 'frozen' for the two write-off/frozen warehouses,
-- which the business tracks separately from live retail stock on purpose
-- (not a real city, shown as its own section regardless of city filter).
-- A product/day/склад not in this mapping at all (e.g. "Кайнар", which the
-- business confirmed is empty and not worth tracking) is simply skipped by
-- the sync, same as before.

-- Every existing row predates the store dimension (store would be NULL,
-- which a primary-key column can't be) and is fully re-derivable from
-- МойСклад on the next sync anyway — wiping and resyncing is simpler and
-- safer than trying to backfill a store value for old rows in place.
truncate table public.moysklad_product_stock;
truncate table public.moysklad_product_sales_daily;

alter table public.moysklad_product_stock add column if not exists store text;
alter table public.moysklad_product_sales_daily add column if not exists store text;

-- Drop whatever the old (unnamed, auto-generated) PK/unique constraints
-- ended up called, by introspection rather than guessing the generated
-- name — guessing wrong would leave the old product_ms_id-only constraint
-- in place, silently rejecting a second city's row for the same product.
do $$
declare con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.moysklad_product_stock'::regclass and contype = 'p'
  loop
    execute format('alter table public.moysklad_product_stock drop constraint %I', con.conname);
  end loop;
  for con in
    select conname from pg_constraint
    where conrelid = 'public.moysklad_product_sales_daily'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.moysklad_product_sales_daily drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.moysklad_product_stock add primary key (product_ms_id, store);
alter table public.moysklad_product_sales_daily alter column store set not null;
alter table public.moysklad_product_sales_daily add unique (product_ms_id, sale_date, store);

create or replace function public.product_sales_summary(p_from date, p_to date, p_stores text[] default null)
returns table (
  product_ms_id text,
  product_name text,
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
    s.product_ms_id,
    coalesce(p.name, max(s.product_name)) as product_name,
    p.category,
    sum(s.revenue) as revenue,
    sum(s.quantity) as quantity,
    sum(s.cost) as cost,
    count(distinct s.sale_date) filter (where s.quantity > 0)::int as days_with_sales
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (p_stores is null or s.store = any(p_stores))
  group by s.product_ms_id, p.name, p.category
$$;

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
  where s.stock > 0
    and (p_stores is null or s.store = any(p_stores))
    and (ls.last_sale_date is null or (current_date - ls.last_sale_date) > p_stale_days)
  group by s.product_ms_id, s.product_name, ls.last_sale_date
$$;
