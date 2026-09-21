-- Adds an "owner" role, one level above admin: the owner has full access
-- everywhere admin does, but no one (including other admins) can delete or
-- modify the owner's own account — that protection is enforced in the API
-- routes, not here. This migration only needs to: (1) guarantee at most one
-- owner ever exists, and (2) make the shared access-check functions treat
-- "owner" the same as "admin" everywhere RLS relies on them.
-- Run once in the Supabase SQL Editor. Safe to re-run.

alter table public.user_roles drop constraint if exists user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
  check (role = any (array['owner', 'admin', 'editor']));

create unique index if not exists user_roles_single_owner
  on public.user_roles (role)
  where role = 'owner';

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles where user_id = auth.uid() and role in ('admin', 'owner')
  );
$$;

create or replace function public.has_access(p_section text, p_need text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select
      case
        when ur.role in ('admin', 'owner') then true
        when p_need = 'edit' then rp.can_edit
        else rp.can_view
      end
    from public.user_roles ur
    left join public.role_permissions rp
      on rp.role_id = ur.role_id and rp.section = p_section
    where ur.user_id = auth.uid()
  ), false);
$$;
