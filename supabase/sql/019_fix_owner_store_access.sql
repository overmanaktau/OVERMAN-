-- has_store_access() special-cased role='admin' but not role='owner', so an
-- owner with no explicit role_store_access rows (the normal case — owners
-- aren't granted per-store) fell through to the exists(...) check and got
-- false for every store, hiding all data behind any RLS policy that calls
-- it (e.g. traffic_entries). Add the same owner bypass has_access()/is_admin()
-- already use.

create or replace function public.has_store_access(p_store_code text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select case
       when ur.role in ('owner', 'admin') then true
       else exists (
         select 1
         from public.role_store_access rsa
         join public.stores s on s.code = p_store_code
         where rsa.role_id = ur.role_id
           and (
             rsa.scope = 'all'
             or (rsa.scope = 'city' and rsa.city_id = s.city_id)
             or (rsa.scope = 'store' and rsa.store_id = s.id)
           )
       )
     end
     from public.user_roles ur
     where ur.user_id = auth.uid()),
    false
  );
$function$;
