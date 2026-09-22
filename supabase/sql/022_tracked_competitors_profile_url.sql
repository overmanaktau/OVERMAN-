-- Внесение конкурентов теперь по ссылке на профиль (однозначнее ника — не
-- путается формат на разных платформах, и сразу кликабельна). Ник по-прежнему
-- хранится и парсится из ссылки — на нём завязан unique(platform, handle).

alter table public.tracked_competitors add column if not exists profile_url text;
