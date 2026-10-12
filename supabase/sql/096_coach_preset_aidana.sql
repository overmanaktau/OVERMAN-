-- Бот-помощник: Айдана (администратор точки Актобе) получает роль администратора города заранее —
-- как только выберет себя при регистрации и руководитель подтвердит, меню будет по роли, а недельный
-- PDF «Сравнение недель» по Актобе (понедельник 9:00) уйдёт ей сам.
insert into public.coach_role_presets (employee_ms_id, role, note) values
  ('9e55e674-c53a-11f1-0a80-0e78002f45c7', 'city_admin', 'Бекболатова Айдана админ 04')
on conflict (employee_ms_id) do update set role = excluded.role, note = excluded.note;
