-- Доступ к складу по страницам (17.10.2026): вместо одной галочки «Склад» — четыре отдельные: Обзор, АВС/XYZ анализ, Зависшие остатки, По поставщикам.
-- 1) Текущий доступ сохраняется: у кого была галочка «Склад», появляются все четыре.
-- 2) Таблицы склада защищены политиками has_access('warehouse.stock','view') — теперь эта проверка проходит, если у роли есть ЛЮБАЯ из четырёх страниц
--    (политики менять не нужно). Какую страницу видит сотрудник, решает сайт по отдельным галочкам.
-- Старые строки 'warehouse.stock' в role_permissions после выкладки сайта удаляются отдельно (сайт их больше не читает).
insert into public.role_permissions (role_id, section, can_view, can_edit)
select rp.role_id, s.section, rp.can_view, false
from public.role_permissions rp
cross join (values ('warehouse.overview'), ('warehouse.abc_xyz'), ('warehouse.stale'), ('warehouse.suppliers')) as s(section)
where rp.section = 'warehouse.stock'
on conflict (role_id, section) do nothing;

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
        when p_section = 'warehouse.stock' then exists (
          select 1 from public.role_permissions w
          where w.role_id = ur.role_id
            and w.section in ('warehouse.overview', 'warehouse.abc_xyz', 'warehouse.stale', 'warehouse.suppliers')
            and (case when p_need = 'edit' then w.can_edit else w.can_view end)
        )
        when p_need = 'edit' then rp.can_edit
        else rp.can_view
      end
    from public.user_roles ur
    left join public.role_permissions rp
      on rp.role_id = ur.role_id and rp.section = p_section
    where ur.user_id = auth.uid()
  ), false);
$$;
