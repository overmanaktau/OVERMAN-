-- Renaming a social network (instead of only add/delete) needs its own
-- update policy — 031 only added select/insert/delete.

drop policy if exists social_networks_update on public.social_networks;
create policy social_networks_update on public.social_networks
  for update using (public.has_access('settings.passwords', 'edit'))
  with check (public.has_access('settings.passwords', 'edit'));
