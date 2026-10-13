-- Уведомления МойСклад о новых/изменённых чеках и возвратах (веб-хук). Веб-хук только записывает событие и отвечает сразу;
-- обработчик (раз в минуту и сразу после уведомления) обновляет данные покупателя на экране /client. Пустая очередь — ни одного запроса к МойСклад.
-- Пишет и читает только сервер (service role).
create table if not exists public.ms_webhook_events (
  id bigserial primary key,
  entity_type text not null,     -- retaildemand | retailsalesreturn
  action text not null,          -- CREATE | UPDATE
  href text not null,            -- ссылка на документ в МойСклад
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  client_ms_id text,
  error text
);
create index if not exists ms_webhook_events_pending on public.ms_webhook_events (id) where processed_at is null;
alter table public.ms_webhook_events enable row level security;
