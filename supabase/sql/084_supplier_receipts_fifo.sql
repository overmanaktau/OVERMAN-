-- Приходы поставщика: точный пошаговый учёт FIFO по датам вместо приблизительного.
--
-- Для каждого товара на каждом складе берём приходы (приёмка, оприходование,
-- перемещение на склад) от старых к новым и «проигрываем» события по датам:
--   продажи (за вычетом возвратов, из ежедневных продаж) и перемещения на другой склад.
-- Каждое событие списывает товар с самого старого прихода, который уже был на складе в тот день.
-- Перемещение со склада — это «Перемещено», а не продажа.
--
-- Баланс всегда сходится с текущим остатком склада:
--   остаток (сумма по приходам) = остаток на складе.
-- Если продаж и перемещений известно больше, чем пришло по документам, значит часть товара
-- лежала на складе ещё до документов («входящий остаток») и списывается первой.
-- Если известно меньше, чем нужно по остатку (продажи до 2026 года, списания, потери),
-- разница считается проданной и списывается с самых старых приходов.

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
language plpgsql
stable
as $$
declare
  pr record;
  ev record;
  l_supply text[]; l_doc text[]; l_date date[]; l_line integer[]; l_qty numeric[]; l_price numeric[]; l_type text[]; l_counter text[];
  rem numeric[];
  mov numeric[];
  n integer;
  i integer;
  total_in numeric;
  stock_q numeric;
  known numeric;
  opening numeric;
  residual numeric;
  q numeric;
  take numeric;
begin
  for pr in
    select it.product_ms_id as pid, it.store as st, max(p.name) as pname, max(coalesce(p.article, p.name)) as art
    from public.moysklad_supply_items it
    join public.moysklad_products p on p.id = it.product_ms_id
    where coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') = p_supplier
      and (p_stores is null or it.store = any(p_stores))
      and it.doc_type in ('supply', 'enter', 'move_in')
    group by it.product_ms_id, it.store
  loop
    select array_agg(it.supply_id order by it.doc_date, it.supply_id, it.line_no),
           array_agg(it.doc_name order by it.doc_date, it.supply_id, it.line_no),
           array_agg(it.doc_date order by it.doc_date, it.supply_id, it.line_no),
           array_agg(it.line_no order by it.doc_date, it.supply_id, it.line_no),
           array_agg(it.quantity order by it.doc_date, it.supply_id, it.line_no),
           array_agg(it.price order by it.doc_date, it.supply_id, it.line_no),
           array_agg(it.doc_type order by it.doc_date, it.supply_id, it.line_no),
           array_agg(it.counter_store order by it.doc_date, it.supply_id, it.line_no)
      into l_supply, l_doc, l_date, l_line, l_qty, l_price, l_type, l_counter
    from public.moysklad_supply_items it
    where it.product_ms_id = pr.pid and it.store = pr.st and it.doc_type in ('supply', 'enter', 'move_in');

    n := array_length(l_qty, 1);
    rem := l_qty;
    mov := array_fill(0::numeric, array[n]);

    select coalesce(sum(x), 0) into total_in from unnest(l_qty) as x;
    select coalesce(sum(s.stock), 0) into stock_q
      from public.moysklad_product_stock s where s.product_ms_id = pr.pid and s.store = pr.st;

    -- всё, что известно об уходе товара: продажи (минус возвраты) и перемещения на другой склад
    select coalesce(sum(e.qq), 0) into known from (
      select greatest(0, sd.quantity - coalesce(sd.returned_quantity, 0)) as qq
        from public.moysklad_product_sales_daily sd where sd.product_ms_id = pr.pid and sd.store = pr.st
      union all
      select mo.quantity as qq
        from public.moysklad_supply_items mo
        where mo.product_ms_id = pr.pid and mo.store = pr.st and mo.doc_type = 'move_out'
    ) e;

    opening := greatest(0, stock_q + known - total_in);   -- лежало до документов
    residual := greatest(0, total_in - stock_q - known);  -- ушло неизвестно куда (считаем продажей)

    -- неизвестный уход — с самых старых приходов
    i := 1;
    q := residual;
    while q > 0 and i <= n loop
      take := least(q, rem[i]);
      rem[i] := rem[i] - take;
      q := q - take;
      i := i + 1;
    end loop;

    -- события по датам: каждое списывает самый старый приход, который уже был на складе
    for ev in
      select e.d, e.kind, sum(e.qq) as qq from (
        select sd.sale_date as d, 1 as kind, greatest(0, sd.quantity - coalesce(sd.returned_quantity, 0)) as qq
          from public.moysklad_product_sales_daily sd where sd.product_ms_id = pr.pid and sd.store = pr.st
        union all
        select mo.doc_date as d, 2 as kind, mo.quantity as qq
          from public.moysklad_supply_items mo
          where mo.product_ms_id = pr.pid and mo.store = pr.st and mo.doc_type = 'move_out'
      ) e
      group by e.d, e.kind
      order by e.d, e.kind
    loop
      q := ev.qq;
      if opening > 0 then
        take := least(q, opening);
        opening := opening - take;
        q := q - take;
      end if;
      i := 1;
      while q > 0 and i <= n loop
        if l_date[i] <= ev.d and rem[i] > 0 then
          take := least(q, rem[i]);
          rem[i] := rem[i] - take;
          if ev.kind = 2 then mov[i] := mov[i] + take; end if;
          q := q - take;
        end if;
        i := i + 1;
      end loop;
    end loop;

    -- если что-то не удалось списать (событие раньше всех приходов), остаток всё равно
    -- должен сойтись со складом: лишнее считаем проданным со старых приходов
    q := greatest(0, opening + (select coalesce(sum(x), 0) from unnest(rem) as x) - stock_q);
    if q > 0 then
      take := least(q, opening);
      opening := opening - take;
      q := q - take;
      i := 1;
      while q > 0 and i <= n loop
        take := least(q, rem[i]);
        rem[i] := rem[i] - take;
        q := q - take;
        i := i + 1;
      end loop;
    end if;

    for i in 1..n loop
      supply_id := l_supply[i];
      doc_name := l_doc[i];
      doc_date := l_date[i];
      store := pr.st;
      line_no := l_line[i];
      product_ms_id := pr.pid;
      product_name := pr.pname;
      article := pr.art;
      quantity := l_qty[i];
      price := l_price[i];
      cur_stock := stock_q;
      remaining := rem[i];
      moved := mov[i];
      doc_type := l_type[i];
      counter_store := l_counter[i];
      return next;
    end loop;
  end loop;
end;
$$;

grant execute on function public.supplier_receipts(text, text[]) to authenticated;
