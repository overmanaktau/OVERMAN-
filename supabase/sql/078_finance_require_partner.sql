-- Статьи про займы партнёров: при внесении операции обязателен выбор партнёра.
alter table public.fin_categories add column if not exists require_partner boolean not null default false;

update public.fin_categories set require_partner = true
where parent_id is null
  and name in ('Займ от партнёра (получено)', 'Возврат займа партнёру', 'Займ партнёру (выдан)', 'Возврат займа от партнёра');
