-- Закупщик в боте-помощнике: свои отчёты (Отчёт, ABC/XYZ, Проданные товары) с выбором города, периода и поставщиков.
--  · coach_buyer_state — что закупщик выбрал на шагах (вид отчёта, город, период, список поставщиков и снятые галочки);
--  · buyer_suppliers — поставщики, у которых за период есть продажи (список для галочек);
--  · product_sales_summary_by_article_sup — то же, что product_sales_summary_by_article, только по выбранным поставщикам;
--  · buyer_sold_products — проданные артикулы: штуки, оборот по себестоимости и по продажной цене, остаток в штуках на последний день периода.
-- Остаток на последний день: за периоды, заканчивающиеся вчера или позже, — текущий остаток склада; за прошедшие — восстанавливается от
-- текущего остатка по документам после этой даты (продажи за вычетом возвратов, перемещения со склада и приходы), поштучно по товарам.

create table if not exists public.coach_buyer_state (
  user_id bigint primary key references public.coach_users(id) on delete cascade,
  kind text not null,
  city text,
  from_date date,
  to_date date,
  title text,
  suppliers text[] not null default '{}',
  off integer[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.coach_buyer_state enable row level security;

create or replace function public.buyer_suppliers(p_stores text[], p_from date, p_to date)
returns table (supplier_name text)
language sql
stable
as $$
  select distinct coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and s.store = any(p_stores)
    and (s.quantity <> 0 or s.revenue <> 0)
  order by 1
$$;

create or replace function public.product_sales_summary_by_article_sup(p_from date, p_to date, p_stores text[] default null, p_suppliers text[] default null)
returns table (
  article text,
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
    s.article,
    max(p.category) as category,
    sum(s.revenue) as revenue,
    sum(s.quantity) as quantity,
    sum(s.cost) as cost,
    count(distinct s.sale_date) filter (where s.quantity > 0)::int as days_with_sales
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (p_stores is null or s.store = any(p_stores))
    and s.article is not null
    and (p_suppliers is null or coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') = any(p_suppliers))
  group by s.article
$$;

create or replace function public.buyer_sold_products(p_stores text[], p_from date, p_to date, p_suppliers text[] default null)
returns table (
  article text,
  category text,
  supplier_name text,
  quantity numeric,
  revenue numeric,
  cost numeric,
  stock_qty_end numeric
)
language sql
stable
as $$
  with prod as (
    select p.id as pid,
           coalesce(p.article, p.name) as art,
           p.category as cat,
           coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as sname
    from public.moysklad_products p
  ),
  sold as (
    select s.product_ms_id as pid, sum(s.quantity) as q, sum(s.revenue) as rev, sum(s.cost) as cst
    from public.moysklad_product_sales_daily s
    where s.sale_date between p_from and p_to and s.store = any(p_stores)
    group by 1
  ),
  cur as (
    select product_ms_id as pid, sum(stock) as st
    from public.moysklad_product_stock
    where store = any(p_stores)
    group by 1
  ),
  aft_sales as (
    select product_ms_id as pid, sum(greatest(0, quantity - coalesce(returned_quantity, 0))) as q
    from public.moysklad_product_sales_daily
    where store = any(p_stores) and sale_date > p_to
    group by 1
  ),
  aft_out as (
    select product_ms_id as pid, sum(quantity) as q
    from public.moysklad_supply_items
    where store = any(p_stores) and doc_type = 'move_out' and doc_date > p_to
    group by 1
  ),
  aft_in as (
    select product_ms_id as pid, sum(quantity) as q
    from public.moysklad_supply_items
    where store = any(p_stores) and doc_type in ('supply', 'enter', 'move_in') and doc_date > p_to
    group by 1
  ),
  base as (
    select u.art, u.cat, u.sname,
           coalesce(sd.q, 0) as q, coalesce(sd.rev, 0) as rev, coalesce(sd.cst, 0) as cst,
           greatest(0,
             case when p_to >= public.almaty_today() - 1 then coalesce(c.st, 0)
                  else coalesce(c.st, 0) + coalesce(a.q, 0) + coalesce(o.q, 0) - coalesce(i.q, 0) end
           ) as stock_end
    from prod u
    left join sold sd on sd.pid = u.pid
    left join cur c on c.pid = u.pid
    left join aft_sales a on a.pid = u.pid
    left join aft_out o on o.pid = u.pid
    left join aft_in i on i.pid = u.pid
    where p_suppliers is null or u.sname = any(p_suppliers)
  )
  select b.art, max(b.cat), max(b.sname), sum(b.q), sum(b.rev), sum(b.cst), sum(b.stock_end)
  from base b
  where b.art in (select art from base where q <> 0 or rev <> 0)
  group by b.art
  order by sum(b.rev) desc
$$;
