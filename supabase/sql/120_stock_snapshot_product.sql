-- Остатки по каждому товару на конец каждого дня (штуки) — для отчёта закупщика «Проданные товары» (остаток на последний день периода).
-- Хранятся только два основных склада (Overman Актау и Overman Актобе), только позиции с остатком не ноль. Ежедневно пополняется ночным снимком остатков
-- (lib/stockSnapshot.ts), история с 01.09.2026 восстановлена из отчёта МойСклад «Остатки» на конец каждого дня.
-- buyer_sold_products берёт остаток из этого снимка, если он есть на последний день периода; иначе — текущий остаток (вчера и позже) или
-- восстанавливает от текущего по документам (для дат до начала снимков).

create table if not exists public.moysklad_stock_snapshot_product_daily (
  snapshot_date date not null,
  store text not null,
  product_ms_id text not null,
  stock numeric not null,
  primary key (snapshot_date, store, product_ms_id)
);
alter table public.moysklad_stock_snapshot_product_daily enable row level security;

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
  has_snap as (
    select exists (
      select 1 from public.moysklad_stock_snapshot_product_daily
      where snapshot_date = p_to and store = any(p_stores)
    ) as yes
  ),
  snap as (
    select product_ms_id as pid, sum(stock) as st
    from public.moysklad_stock_snapshot_product_daily
    where snapshot_date = p_to and store = any(p_stores)
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
             case when (select yes from has_snap) then coalesce(sn.st, 0)
                  when p_to >= public.almaty_today() - 1 then coalesce(c.st, 0)
                  else coalesce(c.st, 0) + coalesce(a.q, 0) + coalesce(o.q, 0) - coalesce(i.q, 0) end
           ) as stock_end
    from prod u
    left join sold sd on sd.pid = u.pid
    left join snap sn on sn.pid = u.pid
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
