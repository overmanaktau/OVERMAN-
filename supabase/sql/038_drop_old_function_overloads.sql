-- 037 added p_stores as a new parameter via "create or replace function",
-- but a function's identity in Postgres includes its parameter list — a
-- different parameter list means a NEW, separate overload, not a
-- replacement. The old single-argument versions from 034/036 were left
-- behind, so any call with just the original arguments (e.g. the site's
-- pre-037 deployed code, or a cron job calling the old shape) is now
-- ambiguous between the two overloads and fails outright ("Could not
-- choose the best candidate function"). Drop the old ones explicitly.

drop function if exists public.product_sales_summary(date, date);
drop function if exists public.stale_inventory(int);
