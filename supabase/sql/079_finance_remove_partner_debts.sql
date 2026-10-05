-- Убираем долги партнёров: остаются долги поставщикам и расчёты между магазинами.
-- Партнёры как справочник остаются — под них заведены подпункты статьи «Дивиденды».
-- Эта миграция применяется, только если партнёрских долгов, операций с партнёром и
-- плановых платежей с партнёром ещё нет (на момент написания их не было).

do $$
begin
  if exists (select 1 from public.fin_debts where kind = 'partner')
     or exists (select 1 from public.fin_operations where partner_id is not null)
     or exists (select 1 from public.fin_planned_payments where partner_id is not null)
     or exists (select 1 from public.fin_operations o join public.fin_categories c on c.id = o.category_id where c.require_partner)
     or exists (select 1 from public.fin_planned_payments o join public.fin_categories c on c.id = o.category_id where c.require_partner) then
    raise exception 'есть данные по долгам партнёров — удаление остановлено';
  end if;
end $$;

-- Защита долга больше не смотрит на partner_id
create or replace function public.fin_debts_protect()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' then
    if new.locked is distinct from old.locked or new.unlock_expires_at is distinct from old.unlock_expires_at then
      raise exception 'служебные поля долга менять нельзя';
    end if;
    -- закрытие долга и привязка операции — часть погашения, запрос не нужен
    if (new.kind, new.direction, new.store, new.counterparty_store, new.supplier_id,
        new.amount, new.debt_date, new.due_date, new.comment, new.doc_number)
       is not distinct from
       (old.kind, old.direction, old.store, old.counterparty_store, old.supplier_id,
        old.amount, old.debt_date, old.due_date, old.comment, old.doc_number) then
      return new;
    end if;
  end if;
  if old.unlock_expires_at is null or old.unlock_expires_at <= now() then
    raise exception 'изменить или удалить долг можно только по одобренному запросу';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

alter table public.fin_debts drop constraint if exists fin_debts_kind_check;
alter table public.fin_debts add constraint fin_debts_kind_check check (kind in ('store_store', 'supplier'));

alter table public.fin_debts drop column if exists partner_id;
alter table public.fin_operations drop column if exists partner_id;
alter table public.fin_planned_payments drop column if exists partner_id;

-- Статьи займов партнёров больше не нужны
delete from public.fin_categories
where parent_id is null
  and name in ('Займ от партнёра (получено)', 'Возврат займа партнёру', 'Займ партнёру (выдан)', 'Возврат займа от партнёра');
alter table public.fin_categories drop column if exists require_partner;
