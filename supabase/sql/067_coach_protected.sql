-- Бот-помощник: защищённый владелец (главный). Его нельзя отключить, убрать, отклонить
-- и поменять ему роль — ни другим владельцам, ни администраторам. Остальных
-- владельцев и администраторов отключать и убирать можно.
-- Пример: update coach_users set is_protected = true where telegram_user_id = <id>;

alter table public.coach_users add column if not exists is_protected boolean not null default false;
