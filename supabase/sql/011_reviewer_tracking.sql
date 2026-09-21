-- Records who approved/denied a request, alongside the existing reviewed_at.
-- reviewed_by_name is captured at write time (like changed_by_name on
-- edit_history) so it keeps showing correctly even if that reviewer's
-- account is later deleted.
alter table public.edit_requests add column if not exists reviewed_by uuid references auth.users(id) on delete set null;
alter table public.edit_requests add column if not exists reviewed_by_name text;
