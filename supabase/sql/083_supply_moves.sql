-- «Приёмки» теперь учитывают не только приёмки от поставщика, но и всё, что
-- меняет остаток склада кроме продаж:
--   supply   — приёмка от поставщика;
--   enter    — оприходование;
--   move_in  — перемещение на этот склад (приход на склад-получатель);
--   move_out — перемещение с этого склада (уходит на другой склад, это НЕ продажа).
-- Приходом (партией) считаются supply, enter и move_in. Продажи списываются с самого
-- старого прихода, перемещения со склада — тоже с самого старого, но показываются
-- отдельно («Перемещено»), чтобы не выдавать их за продажи.

alter table public.moysklad_supply_items add column if not exists doc_type text not null default 'supply';
alter table public.moysklad_supply_items add column if not exists counter_store text; -- у перемещений: второй склад

drop function if exists public.supplier_receipts(text, text[]);

create function public.supplier_receipts(p_supplier text, p_stores text[] default null)
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
  remaining numeric,
  moved numeric,
  doc_type text,
  counter_store text
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
           i.doc_type, i.counter_store,
           p.name as product_name, coalesce(p.article, p.name) as article
    from public.moysklad_supply_items i
    join prods p on p.id = i.product_ms_id
    where (p_stores is null or i.store = any(p_stores))
  ),
  lots as (
    select * from items where doc_type in ('supply', 'enter', 'move_in')
  ),
  outs as (
    select product_ms_id, store, sum(quantity) as moved_out
    from items where doc_type = 'move_out'
    group by product_ms_id, store
  ),
  stock as (
    select product_ms_id, store, sum(stock) as stock
    from public.moysklad_product_stock
    group by product_ms_id, store
  ),
  total_in as (
    select product_ms_id, store, sum(quantity) as total_in
    from lots group by product_ms_id, store
  ),
  ranked as (
    select l.*,
           coalesce(s.stock, 0) as cur_stock,
           greatest(0, t.total_in - coalesce(s.stock, 0)) as out_total,        -- сколько ушло со склада: продажи + перемещения
           coalesce(o.moved_out, 0) as moved_out,
           coalesce(
             sum(l.quantity) over (
               partition by l.product_ms_id, l.store
               order by l.doc_date asc, l.supply_id asc, l.line_no asc
               rows between unbounded preceding and 1 preceding
             ), 0) as older_qty                                                 -- приходы старше этого
    from lots l
    join total_in t on t.product_ms_id = l.product_ms_id and t.store = l.store
    left join stock s on s.product_ms_id = l.product_ms_id and s.store = l.store
    left join outs o on o.product_ms_id = l.product_ms_id and o.store = l.store
  ),
  calc as (
    select r.*,
           -- сколько списано с этого прихода (с самого старого прихода вперёд)
           greatest(0, least(r.quantity, r.out_total - r.older_qty)) as consumed
    from ranked r
  )
  select c.supply_id, c.doc_name, c.doc_date, c.store, c.line_no, c.product_ms_id, c.product_name, c.article,
         c.quantity, c.price, c.cur_stock,
         c.quantity - c.consumed as remaining,
         -- из списанного: доля перемещений в общем уходе со склада (если уходов не было — 0)
         case when c.out_total > 0 then c.consumed * least(c.moved_out, c.out_total) / c.out_total else 0 end as moved,
         c.doc_type, c.counter_store
  from calc c
$$;

grant execute on function public.supplier_receipts(text, text[]) to authenticated;
