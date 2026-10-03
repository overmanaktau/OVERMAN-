-- Бот-помощник: «Тестовый сотрудник». Его можно выбрать при регистрации в любом
-- городе, он никогда не занят: сколько угодно Telegram-аккаунтов могут сидеть
-- в нём одновременно. После подтверждения владельцем каждому даётся 30 минут
-- (test_expires_at), потом система сама выводит его (статус 'left') и всё
-- начинается заново. test_role — что показывает тест: консультанта или руководителя.
-- Цифры в тестовом режиме условные, настоящие данные сотрудников не показываются.

alter table public.coach_users add column if not exists is_test boolean not null default false;
alter table public.coach_users add column if not exists test_role text check (test_role in ('consultant', 'manager'));
alter table public.coach_users add column if not exists test_expires_at timestamptz;

-- Один настоящий сотрудник — один действующий Telegram-аккаунт; тестовые не считаются.
drop index if exists public.coach_users_employee_active;
create unique index coach_users_employee_active
  on public.coach_users (employee_ms_id)
  where status in ('pending', 'approved') and not is_test;
