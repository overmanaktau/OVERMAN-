-- Онлайн-чеки Актау: ответы Нуржана на вопрос «Это онлайн-продажа?» по чекам, где комментарий похож на «онлайн», но не уверенно.
-- Одна строка на чек МойСклад: вопрос задан (asked_at), ответ (online: true — онлайн, false — нет, null — ещё без ответа).
-- Пока ответа нет, чек онлайн не считается. Таблицу читает и пишет только сервер (service role), политик нет.
create table if not exists public.online_check_answers (
  demand_id text primary key,
  ref_date date not null,
  online boolean,
  asked_at timestamptz not null default now(),
  answered_by bigint references public.coach_users(id) on delete set null,
  answered_at timestamptz
);
alter table public.online_check_answers enable row level security;
