-- График смен: по строке на сотрудника и дату — утро, вечер или выходной.
-- Нет строки = смена не назначена. Видеть график всех может роль с правом
-- "График смен" (просмотр), менять — с правом на редактирование; свои смены
-- сотрудник видит всегда (понадобится боту, чтобы знать, кому сегодня писать).
create table if not exists public.work_shifts (
  user_id uuid not null references auth.users(id) on delete cascade,
  shift_date date not null,
  kind text not null check (kind in ('morning', 'evening', 'off')),
  primary key (user_id, shift_date)
);

create index if not exists work_shifts_date_idx on public.work_shifts (shift_date);

alter table public.work_shifts enable row level security;

drop policy if exists work_shifts_select on public.work_shifts;
drop policy if exists work_shifts_insert on public.work_shifts;
drop policy if exists work_shifts_update on public.work_shifts;
drop policy if exists work_shifts_delete on public.work_shifts;

create policy work_shifts_select on public.work_shifts
  for select using (public.has_access('schedule', 'view') or user_id = auth.uid());
create policy work_shifts_insert on public.work_shifts
  for insert with check (public.has_access('schedule', 'edit'));
create policy work_shifts_update on public.work_shifts
  for update using (public.has_access('schedule', 'edit'))
  with check (public.has_access('schedule', 'edit'));
create policy work_shifts_delete on public.work_shifts
  for delete using (public.has_access('schedule', 'edit'));
