-- План продаж теперь вносится по сотрудникам: одна строка = точка + сотрудник
-- (из МойСклад) + дата. План точки/месяца — сумма планов сотрудников, её считает
-- окно «План продаж» на «Обзоре» и «Продаже».
-- Таблица из 056 на момент миграции пустая (внесение плана ещё не использовалось
-- в бою), поэтому колонки сотрудника можно добавить обязательными.

alter table public.sales_plan_entries add column if not exists employee_ms_id text not null;
alter table public.sales_plan_entries add column if not exists employee_name text not null;

alter table public.sales_plan_entries drop constraint if exists sales_plan_entries_store_entry_date_key;
alter table public.sales_plan_entries drop constraint if exists sales_plan_entries_employee_date_key;
alter table public.sales_plan_entries
  add constraint sales_plan_entries_employee_date_key unique (store, employee_ms_id, entry_date);
