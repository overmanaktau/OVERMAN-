-- Сгорание бонусов теперь автоматическое (владелец, 17.10.2026): запрос создаётся сразу разрешённым, владельцу в Telegram приходят только сбои.
-- error_notified_at — когда в последний раз сообщали о сбое запуска (чтобы не слать каждые 5 минут).
alter table public.kassa_bonus_expiry_requests add column if not exists error_notified_at timestamptz;
