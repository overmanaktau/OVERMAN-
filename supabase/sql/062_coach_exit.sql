-- Бот-помощник: кнопка «Выход». Сотрудник сам выходит из привязки аккаунта —
-- статус 'left'. Место сотрудника освобождается (уникальный индекс учитывает
-- только pending/approved), а чтобы вернуться, нужно пройти регистрацию заново:
-- город, имя, подтверждение владельцем. rejoined = true, если сотрудник уже
-- выходил раньше, — тогда ему приходит текст о возвращении в систему, а при
-- первом входе — «Добро пожаловать».

alter table public.coach_users drop constraint if exists coach_users_status_check;
alter table public.coach_users
  add constraint coach_users_status_check check (status in ('pending', 'approved', 'rejected', 'disabled', 'left'));

alter table public.coach_users add column if not exists left_at timestamptz;
alter table public.coach_users add column if not exists rejoined boolean not null default false;
