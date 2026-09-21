-- Collapses "city -> several stores" into "city IS the point of sale":
-- exactly one store per city from now on, with the store's name always
-- matching its city's name. Run once in the Supabase SQL Editor.

-- Reassign anything pointing at Актау's second store (Точка 2, id=2) onto
-- its first (Точка 1, id=1) before removing it — keeps historical rows.
update public.traffic_entries set store = (select code from public.stores where id = 1) where store = (select code from public.stores where id = 2);
update public.role_store_access set store_id = 1 where store_id = 2;
delete from public.stores where id = 2;

update public.stores s set name = c.name from public.cities c where s.city_id = c.id;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_city_id_unique') then
    alter table public.stores add constraint stores_city_id_unique unique (city_id);
  end if;
end $$;
