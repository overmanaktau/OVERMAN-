-- Журнал изменений МойСклад (аудит чеков и возвратов): что поменяли, кто, за какую дату, и применили ли мы это
-- в портале (пересчитали день). Пишет только сервер (ночная проверка журнала).
alter table public.moysklad_sync_state add column if not exists audit_cursor text; -- момент последней прочитанной записи журнала (как в МойСклад)

create table if not exists public.moysklad_change_log (
  audit_id text not null,
  entity_id text not null,
  entity_type text not null,        -- retaildemand | retailsalesreturn
  doc_name text,
  doc_date date,                    -- дата документа (чека/возврата)
  event_type text,                  -- create | update | delete
  source text,                      -- posapi (касса) | app (интерфейс) | remap-1.2 (API)
  uid text,                         -- логин того, кто менял
  at_ms text,                       -- момент записи журнала
  diff jsonb,                       -- что изменилось (например, ответственный: было → стало)
  info text,
  detected_at timestamptz not null default now(),
  applied_at timestamptz,           -- когда день пересчитали в портале
  primary key (audit_id, entity_id)
);
create index if not exists moysklad_change_log_pending on public.moysklad_change_log (doc_date) where applied_at is null;
alter table public.moysklad_change_log enable row level security;
