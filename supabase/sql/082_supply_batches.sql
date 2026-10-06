-- Склад → «По поставщикам» → «Приёмки»: каждый приход товара по датам и документам
-- и сколько из него продано. Продажи списываются с самого старого прихода (FIFO),
-- поэтому остаток товара «лежит» в самых свежих приходах: от текущего остатка
-- отнимаются приходы от новых к старым.
--
-- Учитываются только приёмки (документы «Приёмка» в МойСклад). Остаток, пришедший
-- перемещением между складами или оприходованием, в приходах не виден.

create table if not exists public.moysklad_supply_items (
  supply_id text not null,
  line_no integer not null,
  doc_name text,
  doc_date date not null,
  store text not null,
  product_ms_id text not null,
  quantity numeric not null default 0,
  price numeric, -- закупочная цена за штуку, тенге
  agent_name text,
  synced_at timestamptz not null default now(),
  primary key (supply_id, line_no)
);
create index if not exists moysklad_supply_items_product_idx on public.moysklad_supply_items (product_ms_id, store);

alter table public.moysklad_supply_items enable row level security;
drop policy if exists moysklad_supply_items_select on public.moysklad_supply_items;
create policy moysklad_supply_items_select on public.moysklad_supply_items
  for select using (public.has_access('warehouse.stock', 'view'));

-- Приходы поставщика по строкам; remaining — сколько из прихода ещё лежит на складе
create or replace function public.supplier_receipts(p_supplier text, p_stores text[] default null)
returns table (
  supply_id text,
  doc_name text,
  doc_date date,
  store text,
  line_no integer,
  product_ms_id text,
  product_name text,
  article text,
  quantity numeric,
  price numeric,
  cur_stock numeric,
  remaining numeric
)
language sql
stable
as $$
  with prods as (
    select id, name, article
    from public.moysklad_products
    where coalesce(nullif(trim(supplier), ''), 'Без поставщика') = p_supplier
  ),
  items as (
    select i.supply_id, i.doc_name, i.doc_date, i.store, i.line_no, i.product_ms_id, i.quantity, i.price,
           p.name as product_name, coalesce(p.article, p.name) as article
    from public.moysklad_supply_items i
    join prods p on p.id = i.product_ms_id
    where (p_stores is null or i.store = any(p_stores))
  ),
  stock as (
    select product_ms_id, store, sum(stock) as stock
    from public.moysklad_product_stock
    group by product_ms_id, store
  ),
  ranked as (
    select it.*,
           coalesce(s.stock, 0) as cur_stock,
           coalesce(
             sum(it.quantity) over (
               partition by it.product_ms_id, it.store
               order by it.doc_date desc, it.supply_id desc, it.line_no desc
               rows between unbounded preceding and 1 preceding
             ), 0) as newer_qty
    from items it
    left join stock s on s.product_ms_id = it.product_ms_id and s.store = it.store
  )
  select supply_id, doc_name, doc_date, store, line_no, product_ms_id, product_name, article,
         quantity, price, cur_stock,
         greatest(0, least(quantity, cur_stock - newer_qty)) as remaining
  from ranked
$$;
