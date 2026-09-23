-- Returns were already netted out of revenue/receipts_count/items_count but
-- never stored on their own, so there was no way to show "here's what was
-- returned" separately from the final post-return numbers. Store them
-- alongside so the UI can show both: the final (already-netted) figure and,
-- next to it, how much of it was returns.

alter table public.moysklad_sales_daily
  add column if not exists returned_amount numeric not null default 0,
  add column if not exists returned_receipts integer not null default 0,
  add column if not exists returned_items integer not null default 0;
