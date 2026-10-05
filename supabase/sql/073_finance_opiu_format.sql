-- ОПИУ в формате владельца (файл «Финансы 2026 Overman Aktau — ОПИУ»): по месяцам,
-- выручка и себестоимость разбиты по категориям товара (верхняя папка МойСклад:
-- Плечевой, Верхний, Брюки, Обувь, Аксессуары, Бесплатно, Заморозка).
--
-- 1) Функция: продажи и себестоимость по месяцам и категориям товара.
--    Склады «заморозки» идут отдельной категорией «Заморозка» и попадают только
--    в расчёт по всем магазинам.
-- 2) Статьи по умолчанию заменяются на структуру из файла владельца — только если
--    финансами ещё никто не пользовался (нет операций, планов, плановых платежей
--    и статьи остались стартовые).

create or replace function public.finance_sales_by_category(p_from date, p_to date, p_cities text[] default null)
returns table (month date, category text, revenue numeric, cost numeric)
language sql
stable
security definer
set search_path = public
as $$
  with wh(code, city) as (
    values ('overman_aktau', 'point_1'), ('saya_park', 'point_1'),
           ('overman_aktobe', 'point_3'), ('aktobe_discount', 'point_3'),
           ('frozen', null)
  )
  select
    date_trunc('month', s.sale_date)::date as month,
    case when s.store = 'frozen' then 'Заморозка' else coalesce(p.top_category, 'Без категории') end as category,
    sum(s.revenue) as revenue,
    sum(coalesce(s.cost, 0)) as cost
  from public.moysklad_product_sales_daily s
  join wh on wh.code = s.store
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date between p_from and p_to
    and (public.has_access('finance.opiu', 'view') or public.has_access('finance.overview', 'view'))
    and (
      case
        when wh.city is null then p_cities is null and public.has_all_stores_access()
        else public.has_store_access(wh.city) and (p_cities is null or wh.city = any(p_cities))
      end
    )
  group by 1, 2
$$;

do $$
declare
  p bigint;
begin
  if exists (select 1 from public.fin_operations)
     or exists (select 1 from public.fin_planned_payments)
     or exists (select 1 from public.fin_pnl_plan)
     or exists (select 1 from public.fin_debts)
     or (select count(*) from public.fin_categories) <> 26 then
    return;
  end if;

  delete from public.fin_categories where parent_id is not null;
  delete from public.fin_categories;

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Выручка от продаж', 'income', 'revenue', 10);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Себестоимость проданного', 'expense', 'cogs', 20);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Маркетинговые расходы', 'expense', 'opex', 30) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'Таргет Инстаграм', 'expense', 'opex', 10),
    (p, 'Таргет ТикТок', 'expense', 'opex', 20),
    (p, '2GIS', 'expense', 'opex', 30),
    (p, 'Флаер, типография, расходники', 'expense', 'opex', 40),
    (p, 'Фото/Видео съемка, монтаж', 'expense', 'opex', 50),
    (p, 'Акции и розыгрыши', 'expense', 'opex', 60),
    (p, 'Работа с блогерами', 'expense', 'opex', 70),
    (p, 'Работа с публичными страницами', 'expense', 'opex', 80),
    (p, 'Билборды', 'expense', 'opex', 90),
    (p, 'ЗП Коммерческого отдела', 'expense', 'opex', 100),
    (p, 'Прочие расходы маркетинга', 'expense', 'opex', 110);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Заработная плата', 'expense', 'opex', 40) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'Оклад', 'expense', 'opex', 10),
    (p, 'Бонус', 'expense', 'opex', 20),
    (p, 'Клининг', 'expense', 'opex', 30),
    (p, 'Прочие', 'expense', 'opex', 40);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Переменные расходы', 'expense', 'opex', 50) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'Аренда', 'expense', 'opex', 10),
    (p, 'Коммунальные услуги', 'expense', 'opex', 20),
    (p, 'Расходы магазина', 'expense', 'opex', 30),
    (p, 'Расходы помещение', 'expense', 'opex', 40),
    (p, 'Транспортные расходы', 'expense', 'opex', 50),
    (p, 'Командировочные расходы', 'expense', 'opex', 60),
    (p, 'Пакеты', 'expense', 'opex', 70);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Комиссия банка', 'expense', 'opex', 60);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Налоги - отчисления разные', 'expense', 'tax', 70);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Налоги - 3%', 'expense', 'tax', 80);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Прочие доходы', 'income', 'other_income', 90);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Прочие расходы', 'expense', 'other_expense', 100);

  -- Движение капитала — в ОПИУ не входит
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Закупка товара поставщикам', 'expense', null, 110);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Взнос партнёра / займ', 'income', null, 120);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Выплата партнёру / возврат займа', 'expense', null, 130);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Инвестиции в оборудование', 'expense', null, 140);
end $$;
