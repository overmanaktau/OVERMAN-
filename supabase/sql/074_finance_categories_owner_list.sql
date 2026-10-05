-- Статьи финансов — готовый список владельца (заменяет все прежние статьи).
-- Новые признаки статьи:
--   require_supplier — при внесении операции обязателен выбор поставщика («Закуп — товар»);
--   auto_tax — сумма считается автоматически как процент (fin_settings.tax_rate) от
--   безналичных поступлений на счета вида «банк»/«карта» (наличные не касаются).
-- Заменяем только если финансами ещё никто не пользовался — иначе операции и планы
-- потеряли бы статьи.

alter table public.fin_categories add column if not exists require_supplier boolean not null default false;
alter table public.fin_categories add column if not exists auto_tax boolean not null default false;

insert into public.fin_settings (key, value) values
  ('auto_tax', 'true'::jsonb),
  ('tax_rate', '3'::jsonb)
on conflict (key) do nothing;

do $$
declare
  p bigint;
  n int := 0;
begin
  if exists (select 1 from public.fin_operations)
     or exists (select 1 from public.fin_planned_payments)
     or exists (select 1 from public.fin_pnl_plan)
     or exists (select 1 from public.fin_debts) then
    raise exception 'финансы уже используются — статьи не заменяем';
  end if;

  delete from public.fin_categories where parent_id is not null;
  delete from public.fin_categories;

  -- верхний уровень: (название, тип, группа ОПИУ)
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Выручка', 'income', 'revenue', 10);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Возврат клиенту', 'expense', null, 20);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Комиссия банка', 'expense', 'opex', 30);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Комиссия банка - Возврат', 'income', 'other_income', 40);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Заработная плата', 'expense', 'opex', 50) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'ОП - Оклад', 'expense', 'opex', 10),
    (p, 'ОП - Бонус', 'expense', 'opex', 20),
    (p, 'ОМ - Маркетолог', 'expense', 'opex', 30),
    (p, 'ОМ - Таргетолог', 'expense', 'opex', 40),
    (p, 'ОМ - СММ', 'expense', 'opex', 50),
    (p, 'Офис', 'expense', 'opex', 60),
    (p, 'Клининг', 'expense', 'opex', 70),
    (p, 'Швея', 'expense', 'opex', 80);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Расходы магазина', 'expense', 'opex', 60) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'Сервис для клиента', 'expense', 'opex', 10),
    (p, 'Программа учета и интернет', 'expense', 'opex', 20),
    (p, 'Оборудование и техника', 'expense', 'opex', 30),
    (p, 'Услуги разные', 'expense', 'opex', 40),
    (p, 'Аутсорсинг Бухгалтерия', 'expense', 'opex', 50),
    (p, 'Корпоративные мероприятия', 'expense', 'opex', 60),
    (p, 'Прочие расходы', 'expense', 'opex', 70);

  insert into public.fin_categories (name, kind, opiu_group, sort, require_supplier) values ('Закуп - товар', 'expense', null, 70, true);
  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Пакеты', 'expense', 'opex', 80);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Аренда', 'expense', 'opex', 90) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'Магазина', 'expense', 'opex', 10),
    (p, 'Офиса', 'expense', 'opex', 20);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Коммунальные услуги', 'expense', 'opex', 100);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Транспорт', 'expense', 'opex', 110) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'Авиа', 'expense', 'opex', 10),
    (p, 'Фура и ЖД', 'expense', 'opex', 20),
    (p, 'Доставка до клиента', 'expense', 'opex', 30);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Командировочные расходы', 'expense', 'opex', 120);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Маркетинг', 'expense', 'opex', 130) returning id into p;
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
    (p, 'Прочее', 'expense', 'opex', 100);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Налоги', 'expense', 'tax', 140) returning id into p;
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort, auto_tax) values
    (p, '3%', 'expense', 'tax', 10, true);
  insert into public.fin_categories (parent_id, name, kind, opiu_group, sort) values
    (p, 'Пенсионные и другие взносы', 'expense', 'tax', 20);

  insert into public.fin_categories (name, kind, opiu_group, sort) values ('Дивиденды', 'expense', null, 150);
end $$;
