-- moysklad_products is a live catalog snapshot — a product can be fully
-- deleted from МойСклад (not just archived), which drops it from that
-- snapshot on the next sync. Historical facts (a past day's sales, a stock
-- row synced before the deletion) must survive that; a hard FK made a
-- deleted product's old sales day fail to sync at all ("is not present in
-- table moysklad_products"). product_sales_summary()'s LEFT JOIN already
-- tolerates a missing catalog row (falls back to the snapshot name, null
-- category) — only the FK itself needs to go.

alter table public.moysklad_product_sales_daily
  drop constraint if exists moysklad_product_sales_daily_product_ms_id_fkey;

alter table public.moysklad_product_stock
  drop constraint if exists moysklad_product_stock_product_ms_id_fkey;
