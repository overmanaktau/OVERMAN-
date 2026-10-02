-- Агрегаты для Telegram-отчётов. Считаем на стороне базы: moysklad_product_sales_daily
-- за 14 дней уже больше 1000 строк (лимит PostgREST), клиентская сумма дала бы кусок.

-- Топ категорий (по названию папки-листа, как в отчёте) за один день.
create or replace function public.report_top_categories(p_stores text[], p_date date, p_limit int default 5)
returns table (category text, revenue numeric, quantity numeric, cost numeric)
language sql
stable
as $$
  select
    coalesce(p.category, 'Без категории') as category,
    sum(s.revenue) as revenue,
    sum(s.quantity) as quantity,
    sum(s.cost) as cost
  from public.moysklad_product_sales_daily s
  left join public.moysklad_products p on p.id = s.product_ms_id
  where s.sale_date = p_date
    and s.store = any(p_stores)
  group by coalesce(p.category, 'Без категории')
  having sum(s.revenue) > 0
  order by sum(s.revenue) desc
  limit p_limit
$$;

-- Топ товаров (по артикулу — цвета и размеры склеены) за p_days дней, заканчивая p_date,
-- плюс сколько штук продано именно в p_date.
create or replace function public.report_top_products(p_stores text[], p_date date, p_days int default 14, p_limit int default 10)
returns table (article text, quantity numeric, revenue numeric, day_quantity numeric)
language sql
stable
as $$
  select
    s.article,
    sum(s.quantity) as quantity,
    sum(s.revenue) as revenue,
    coalesce(sum(s.quantity) filter (where s.sale_date = p_date), 0) as day_quantity
  from public.moysklad_product_sales_daily s
  where s.sale_date between p_date - (p_days - 1) and p_date
    and s.store = any(p_stores)
    and s.article is not null
  group by s.article
  having sum(s.revenue) > 0
  order by sum(s.revenue) desc
  limit p_limit
$$;
