-- Статья «Дивиденды»: подпункт на каждого партнёра (из «Настройки → Партнёры»).
-- Новый партнёр сам получает подпункт, переименование и скрытие партнёра
-- переносятся на его подпункт.

create or replace function public.fin_partner_dividend_sync()
returns trigger
language plpgsql
as $$
declare
  parent bigint;
begin
  select id into parent from public.fin_categories where name = 'Дивиденды' and parent_id is null limit 1;
  if parent is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    insert into public.fin_categories (parent_id, name, kind, opiu_group, sort, active)
    select parent, new.name, 'expense', null,
           coalesce((select max(sort) from public.fin_categories where parent_id = parent), 0) + 10, new.active
    where not exists (select 1 from public.fin_categories where parent_id = parent and name = new.name);
  elsif new.name is distinct from old.name or new.active is distinct from old.active then
    update public.fin_categories set name = new.name, active = new.active
    where parent_id = parent and name = old.name;
  end if;
  return new;
end;
$$;

drop trigger if exists fin_partner_dividend_sync_trigger on public.fin_partners;
create trigger fin_partner_dividend_sync_trigger
  after insert or update on public.fin_partners
  for each row execute function public.fin_partner_dividend_sync();

-- подпункты для уже заведённых партнёров
insert into public.fin_categories (parent_id, name, kind, opiu_group, sort, active)
select d.id, p.name, 'expense', null, p.id * 10, p.active
from public.fin_partners p
cross join (select id from public.fin_categories where name = 'Дивиденды' and parent_id is null limit 1) d
where not exists (select 1 from public.fin_categories c where c.parent_id = d.id and c.name = p.name);
