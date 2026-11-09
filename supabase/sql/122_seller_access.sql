-- Вход на страницу /seller (продавцы по городам для руководителей) по своему логину и паролю, без входа в портал.
-- Хранится логин и хэш пароля (scrypt), сам пароль — нет. Строку с логином добавляют отдельно (хэш в репозиторий не кладём).
-- Таблицу читает и пишет только сервер (service role), политик нет.
create table if not exists public.seller_access (
  login text primary key,
  password_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.seller_access enable row level security;
