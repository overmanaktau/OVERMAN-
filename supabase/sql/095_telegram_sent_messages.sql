-- Какие сообщения бот отчётов отправил в группы: номер сообщения в Telegram нужен, чтобы при ошибке
-- (например, отчёт ушёл дважды) можно было удалить лишнее: история чата боту недоступна.
-- Пишет только сервер (service role).
create table if not exists public.telegram_sent_messages (
  id bigserial primary key,
  chat_id text not null,
  message_id bigint not null,
  report_kind text,        -- day | week | month | intraday | evening
  report_date date,
  scope text,              -- point_1 | point_3
  sent_at timestamptz not null default now()
);
create index if not exists telegram_sent_messages_recent on public.telegram_sent_messages (sent_at desc);
alter table public.telegram_sent_messages enable row level security;
