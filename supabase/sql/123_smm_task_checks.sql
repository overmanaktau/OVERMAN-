-- «Мои задачи» в боте СММ (только владелец-администратор): отметки о выполнении задач, которые нельзя проверить по данным
-- (TikTok-посты, проверка Telegram-отчётов, проверка расходов по каналам). Одна строка = день + город + задача.
-- Таблицу читает и пишет только сервер (service role), политик нет.
create table if not exists public.smm_task_checks (
  task_date date not null,
  city text not null check (city in ('aktau', 'aktobe')),
  task text not null check (task in ('tiktok', 'reports', 'spend')),
  updated_at timestamptz not null default now(),
  primary key (task_date, city, task)
);
alter table public.smm_task_checks enable row level security;
