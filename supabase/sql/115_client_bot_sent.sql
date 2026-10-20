-- Какие сообщения о бонусах уже отправлены клиентам бота (чтобы не слать одно и то же дважды).
create table if not exists public.client_bot_sent (
  client_ms_id text not null,
  kind text not null,          -- purchase | activated | expiring | expired
  ref text not null,           -- чек (purchase) или дата партии
  sent_at timestamptz not null default now(),
  primary key (client_ms_id, kind, ref)
);
alter table public.client_bot_sent enable row level security;
