-- Бот для клиентов (токен TELEGRAM_CLIENTS_BOT_TOKEN): клиент нажимает «Старт» и делится номером телефона — так мы привязываем
-- его Telegram к клиенту из МойСклад и сможем присылать ему сообщения о бонусах (активация, доступные, списание, сгорание).
-- Сейчас бот только подписывает и привязывает номер, ничего не отправляет. Пишет и читает только сервер (service role).
create table if not exists public.client_bot_subscribers (
  telegram_user_id bigint primary key,
  telegram_chat_id bigint not null,
  username text,
  first_name text,
  phone text,                -- «+7701…», как поделился клиент
  phone_digits text,         -- только цифры, для поиска по клиентам
  client_ms_id text,         -- клиент МойСклад (с самой свежей покупкой по этому номеру), если нашёлся
  client_name text,
  city text,                 -- point_1 (Актау) | point_3 (Актобе) — по тегам клиента в МойСклад
  status text not null default 'pending' check (status in ('pending', 'active', 'stopped', 'blocked')),
  subscribed_at timestamptz,
  stopped_at timestamptz,
  blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_bot_subscribers_phone on public.client_bot_subscribers (phone_digits);
create index if not exists client_bot_subscribers_status on public.client_bot_subscribers (status);
alter table public.client_bot_subscribers enable row level security;
