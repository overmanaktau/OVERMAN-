-- The 5 channel columns on traffic_entries are marketing spend (money), not
-- visitor counts — unlike traffic_plan/traffic_fact, which stay integer.
-- Was integer, rejecting kopecks; switch to numeric so "10 000,25" is valid.

alter table public.traffic_entries
  alter column instagram type numeric using instagram::numeric,
  alter column tiktok type numeric using tiktok::numeric,
  alter column instagram_public type numeric using instagram_public::numeric,
  alter column flyer type numeric using flyer::numeric,
  alter column two_gis type numeric using two_gis::numeric;
