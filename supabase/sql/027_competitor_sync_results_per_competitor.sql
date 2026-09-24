-- Lets an editor tune how many recent posts Apify pulls per competitor each
-- sync, instead of it being a fixed constant in code — directly controls
-- Apify cost (~$0.0023/post * this * competitor count * syncs/month).

alter table public.competitor_sync_settings
  add column if not exists results_per_competitor int not null default 6
    check (results_per_competitor between 1 and 30);
