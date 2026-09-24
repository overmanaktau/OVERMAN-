-- Traffic counts were kept integer on the assumption a visitor count is
-- always whole — but a store can split a shared/ambiguous visitor as half
-- a person (e.g. "заходили 11,5 человек"). Match 024's move on the channel
-- spend columns: switch to numeric so a decimal is accepted.

alter table public.traffic_entries
  alter column traffic_plan type numeric using traffic_plan::numeric,
  alter column traffic_fact type numeric using traffic_fact::numeric;
