-- Бот-помощник: закупщик. Его нет в МойСклад, поэтому в списке регистрации его нет — вместо этого владелец выдаёт ссылку-приглашение
-- (t.me/<бот>?start=<код>): по ней человек подключается сразу подтверждённым и получает только PDF «Обзор» по понедельникам.
-- Утренние сообщения продавцам, меню и разделы консультанта ему не приходят (is_buyer).

alter table public.coach_users add column if not exists is_buyer boolean not null default false;

create table if not exists public.coach_invites (
  code text primary key,
  employee_name text not null,
  store text not null references public.stores(code),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by bigint
);

alter table public.coach_invites enable row level security;
