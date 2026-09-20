-- Per-employee custom access: a personal, hidden "role" row that only that
-- employee uses, so an admin can tweak one person's access without editing
-- (or cloning) a shared role template. Run once in the Supabase SQL Editor.

alter table public.roles add column if not exists is_personal boolean not null default false;
