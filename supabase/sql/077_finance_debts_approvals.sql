-- Долги: займы партнёров, номер накладной, связь долга с денежной операцией.
-- Контроль: изменить или удалить операцию ДДС и долг можно только по одобренному
-- запросу (раздел «Запросы», окно 30 минут) — как у трафика и плана продаж.
-- Не блокируется: новые записи, погашения долгов (они ведутся из раздела «Долги»),
-- служебные записи сервера (auth.uid() is null).

-- ── Статьи для займов партнёров и возврата от поставщика (в ОПИУ не входят) ──
insert into public.fin_categories (name, kind, opiu_group, sort)
select v.name, v.kind, null, v.sort
from (values
  ('Займ от партнёра (получено)', 'income', 160),
  ('Возврат займа партнёру', 'expense', 170),
  ('Займ партнёру (выдан)', 'expense', 180),
  ('Возврат займа от партнёра', 'income', 190),
  ('Возврат от поставщика', 'income', 200)
) as v(name, kind, sort)
where not exists (select 1 from public.fin_categories c where c.name = v.name and c.parent_id is null);

-- ── Долги ────────────────────────────────────────────────────────────────
alter table public.fin_debts add column if not exists doc_number text;
alter table public.fin_debts add column if not exists operation_id bigint references public.fin_operations(id) on delete set null;
alter table public.fin_debts add column if not exists locked boolean not null default true;
alter table public.fin_debts add column if not exists unlock_expires_at timestamptz;

alter table public.fin_operations add column if not exists locked boolean not null default true;
alter table public.fin_operations add column if not exists unlock_expires_at timestamptz;

-- ── Операции: править и удалять только по одобренному запросу ─────────────
create or replace function public.fin_operations_protect()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE'
     and (new.locked is distinct from old.locked or new.unlock_expires_at is distinct from old.unlock_expires_at) then
    raise exception 'служебные поля операции менять нельзя';
  end if;
  -- операции, созданные из раздела «Долги», ведутся там же
  if old.debt_id is not null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.unlock_expires_at is null or old.unlock_expires_at <= now() then
    raise exception 'изменить или удалить операцию можно только по одобренному запросу';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists fin_operations_protect_trigger on public.fin_operations;
create trigger fin_operations_protect_trigger
  before update or delete on public.fin_operations
  for each row execute function public.fin_operations_protect();

-- ── Долги: править и удалять только по одобренному запросу ───────────────
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
    if (new.kind, new.direction, new.store, new.counterparty_store, new.supplier_id, new.partner_id,
        new.amount, new.debt_date, new.due_date, new.comment, new.doc_number)
       is not distinct from
       (old.kind, old.direction, old.store, old.counterparty_store, old.supplier_id, old.partner_id,
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

drop trigger if exists fin_debts_protect_trigger on public.fin_debts;
create trigger fin_debts_protect_trigger
  before update or delete on public.fin_debts
  for each row execute function public.fin_debts_protect();

-- Удаление погашения — только пока долг открыт по запросу
create or replace function public.fin_debt_payments_protect()
returns trigger
language plpgsql
as $$
declare
  d record;
begin
  if auth.uid() is null then
    return old;
  end if;
  select unlock_expires_at into d from public.fin_debts where id = old.debt_id;
  if not found then
    return old; -- долг уже удалён (каскад)
  end if;
  if d.unlock_expires_at is null or d.unlock_expires_at <= now() then
    raise exception 'удалить погашение можно только по одобренному запросу на изменение долга';
  end if;
  return old;
end;
$$;

drop trigger if exists fin_debt_payments_protect_trigger on public.fin_debt_payments;
create trigger fin_debt_payments_protect_trigger
  before delete on public.fin_debt_payments
  for each row execute function public.fin_debt_payments_protect();

-- ── Запросы и история знают про финансы ──────────────────────────────────
alter table public.edit_requests drop constraint if exists edit_requests_table_name_check;
alter table public.edit_requests add constraint edit_requests_table_name_check
  check (table_name in ('traffic_entries', 'extra_expenses', 'sales_plan_monthly', 'sales_plan_periods', 'fin_operations', 'fin_debts'));

alter table public.edit_history drop constraint if exists edit_history_table_name_check;
alter table public.edit_history add constraint edit_history_table_name_check
  check (table_name in ('traffic_entries', 'extra_expenses', 'sales_plan_monthly', 'sales_plan_periods', 'fin_operations', 'fin_debts'));

drop policy if exists edit_requests_insert on public.edit_requests;
create policy edit_requests_insert on public.edit_requests
  for insert with check (
    (public.has_access('marketing.data_entry', 'edit') or public.has_access('sales.plan', 'edit')
      or public.has_access('finance.dds', 'edit') or public.has_access('finance.debts', 'edit'))
    and (store is null or public.has_store_access(store))
    and requested_by = auth.uid()
  );

drop policy if exists edit_history_insert on public.edit_history;
create policy edit_history_insert on public.edit_history
  for insert with check (
    public.has_access('marketing.data_entry', 'edit') or public.has_access('sales.plan', 'edit')
    or public.has_access('finance.dds', 'edit') or public.has_access('finance.debts', 'edit')
  );
