-- Adds an optional city/store tag to stored_passwords so an account can be
-- scoped to one city (e.g. a store-specific Instagram) or left company-wide
-- (null — same "no store" meaning as extra_expenses.store already uses).
-- Not enforced in RLS, same precedent as extra_expenses.store: it's a filter
-- tag, not an access-control boundary — settings.passwords permission alone
-- still gates the whole table.

alter table public.stored_passwords
  add column if not exists store text references public.stores(code) on delete set null;
