-- ОПИУ по показателям владельца, в его порядке: выручка, себестоимость, валовая
-- прибыль, маркетинговые расходы, ФОТ, постоянные расходы, переменные расходы,
-- комиссия банка, налоги — отчисления разные, налоги 3%, рентабельность.
-- «Группа в ОПИУ» у статьи теперь — один из этих показателей.
--   Маркетинг → маркетинговые; Заработная плата → ФОТ;
--   Аренда, Коммунальные услуги, Расходы магазина → постоянные;
--   Пакеты, Транспорт, Командировочные расходы → переменные;
--   Комиссия банка и её возврат → комиссия банка (возврат уменьшает);
--   «Налоги - 3%» и «Налоги - Пенсионные и другие взносы» — отдельными статьями.

alter table public.fin_categories drop constraint if exists fin_categories_opiu_group_check;

-- Налоги разбиваем на две самостоятельные статьи (у каждой свой показатель в ОПИУ)
delete from public.fin_categories where parent_id in (select id from public.fin_categories where name = 'Налоги' and parent_id is null);
delete from public.fin_categories where name = 'Налоги' and parent_id is null;
insert into public.fin_categories (name, kind, opiu_group, sort, auto_tax)
select 'Налоги - 3%', 'expense', 'tax_3', 140, true
where not exists (select 1 from public.fin_categories where name = 'Налоги - 3%');
insert into public.fin_categories (name, kind, opiu_group, sort)
select 'Налоги - Пенсионные и другие взносы', 'expense', 'tax_other', 145
where not exists (select 1 from public.fin_categories where name = 'Налоги - Пенсионные и другие взносы');

update public.fin_categories set opiu_group = 'bank' where parent_id is null and name in ('Комиссия банка', 'Комиссия банка - Возврат');
update public.fin_categories set opiu_group = 'payroll' where parent_id is null and name = 'Заработная плата';
update public.fin_categories set opiu_group = 'fixed' where parent_id is null and name in ('Аренда', 'Коммунальные услуги', 'Расходы магазина');
update public.fin_categories set opiu_group = 'variable' where parent_id is null and name in ('Пакеты', 'Транспорт', 'Командировочные расходы');
update public.fin_categories set opiu_group = 'marketing' where parent_id is null and name = 'Маркетинг';
-- подпункты наследуют показатель пункта
update public.fin_categories c set opiu_group = p.opiu_group from public.fin_categories p where c.parent_id = p.id;
-- всё, что осталось от прежних групп, в ОПИУ не входит
update public.fin_categories set opiu_group = null where opiu_group in ('opex', 'tax', 'other_expense');

alter table public.fin_categories add constraint fin_categories_opiu_group_check
  check (opiu_group in ('revenue', 'cogs', 'marketing', 'payroll', 'fixed', 'variable', 'bank', 'tax_other', 'tax_3', 'other_income', 'other_expense'));

-- Налог 3% по плану ОПИУ ранее ссылался на подпункт — удалённые статьи каскадом чистят план
