-- supplier_receipts считается построчно (пошаговый FIFO), а PostgREST постранично вызывает
-- функцию заново для каждой тысячи строк. Обёртка отдаёт весь результат одним json-значением:
-- функция считается один раз, ограничение «1000 строк» не действует.
create or replace function public.supplier_receipts_json(p_supplier text, p_stores text[] default null)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
  from public.supplier_receipts(p_supplier, p_stores) r
$$;

grant execute on function public.supplier_receipts_json(text, text[]) to authenticated;
