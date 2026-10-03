-- Бот-помощник: у администратора есть область видимости. 'city' — только свой
-- город (точка, к которой привязан его сотрудник): продажи, заявки и сотрудники
-- только этого города. 'all' — все города (владелец).
-- Пример: update coach_users set admin_scope = 'all' where telegram_user_id = <id>;

alter table public.coach_users
  add column if not exists admin_scope text not null default 'city' check (admin_scope in ('city', 'all'));
