-- Бот-помощник: администратор бота. Флаг выставляется вручную в базе (не из
-- бота): у такого сотрудника в меню есть разделы «Заявки» и «Сотрудники» —
-- принять, отклонить, отключить, включить, убрать сотрудников прямо в Telegram.
-- Пример: update coach_users set is_admin = true where telegram_user_id = <id>;

alter table public.coach_users add column if not exists is_admin boolean not null default false;
