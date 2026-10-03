-- Бот-помощник: роли, назначенные заранее по сотруднику МойСклад. Когда такой
-- сотрудник выбирает себя при регистрации, в заявку попадает его роль, а после
-- подтверждения владельцем меню сразу будет по роли. Роль потом можно поменять
-- в боте или на странице портала; после выхода из системы при новой регистрации
-- пресет применяется снова.
-- Таблицу читает и пишет только сервер (service role).

create table if not exists public.coach_role_presets (
  employee_ms_id text primary key,
  role text not null check (role in ('owner', 'city_admin')),
  note text
);

alter table public.coach_role_presets enable row level security;

insert into public.coach_role_presets (employee_ms_id, role, note) values
  ('e9f68217-c6ae-11f0-0a80-19c800065757', 'owner', 'Дамир Директор'),
  ('0bc542e5-a660-11ef-0a80-0422000cf584', 'owner', 'Қайнар'),
  ('b417d396-3051-11f1-0a80-135e001d13d0', 'owner', 'Досхан'),
  ('755c7139-b6de-11f0-0a80-15b80002bbcb', 'city_admin', 'Нуржан Админ')
on conflict (employee_ms_id) do update set role = excluded.role, note = excluded.note;
