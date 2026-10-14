-- Обзор → «Оборачиваемость по категориям»: остаток показываем по факту, как в МойСклад, а оборачиваемость считаем по среднему.
--   stock_value / stock_sale_value          — СРЕДНИЙ остаток за период (для оборачиваемости, как раньше);
--   stock_value_end / stock_sale_value_end  — остаток НА КОНЕЦ периода: если период включает сегодня — живой остаток из таблиц
--                                             (плюс и минус, как «Остатки» в МойСклад), иначе — снимок последнего дня периода.
drop function if exists public.stock_turnover_by_category(text[], date, date);
create function public.stock_turnover_by_category(p_stores text[], p_from date, p_to date)
returns table(category text, cogs numeric, stock_value numeric, revenue numeric, stock_sale_value numeric, stock_value_end numeric, stock_sale_value_end numeric)
language sql
stable
as $$
  with cogs_agg as (
    select
      coalesce(p.top_category, 'Без категории') as category,
      sum(s.cost) as cogs,
      sum(s.revenue) as revenue
    from public.moysklad_product_sales_daily s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.sale_date between p_from and p_to
      and s.store = any(p_stores)
    group by coalesce(p.top_category, 'Без категории')
  ),
  snap_days as (
    select count(distinct snapshot_date) as n
    from public.moysklad_stock_snapshot_daily
    where store = any(p_stores) and snapshot_date between p_from and p_to
  ),
  -- Средний остаток за период: сумма по дням со снимком ÷ число таких дней.
  snap_agg as (
    select
      sn.top_category as category,
      sum(sn.stock_value) / nullif((select n from snap_days), 0) as stock_value,
      sum(sn.stock_sale_value) / nullif((select n from snap_days), 0) as stock_sale_value
    from public.moysklad_stock_snapshot_daily sn
    where sn.store = any(p_stores) and sn.snapshot_date between p_from and p_to
    group by sn.top_category
  ),
  -- Живой остаток сейчас (плюсовые позиции со своей себестоимостью + минусовые в сумме продажи).
  live_stock as (
    select
      coalesce(s.top_category, 'Без категории') as category,
      sum(s.stock * coalesce(s.buy_price, 0)) as stock_value,
      sum(s.stock * coalesce(s.sale_price, 0)) as stock_sale_value
    from public.moysklad_product_stock s
    where s.store = any(p_stores) and s.stock > 0
    group by coalesce(s.top_category, 'Без категории')
    union all
    select
      coalesce(p.top_category, 'Без категории') as category,
      0::numeric as stock_value,
      sum(n.stock * coalesce(n.sale_price, 0)) as stock_sale_value
    from public.moysklad_product_stock_negative n
    left join public.moysklad_products p on p.id = n.product_ms_id
    where n.store = any(p_stores)
    group by coalesce(p.top_category, 'Без категории')
  ),
  live_agg as (
    select category, sum(stock_value) as stock_value, sum(stock_sale_value) as stock_sale_value
    from live_stock
    group by category
  ),
  -- Снимок последнего дня периода (для периодов, закончившихся раньше сегодняшнего дня).
  last_snap as (
    select sn.top_category as category, sum(sn.stock_value) as stock_value, sum(sn.stock_sale_value) as stock_sale_value
    from public.moysklad_stock_snapshot_daily sn
    where sn.store = any(p_stores)
      and sn.snapshot_date = (
        select max(snapshot_date) from public.moysklad_stock_snapshot_daily
        where store = any(p_stores) and snapshot_date between p_from and p_to
      )
    group by sn.top_category
  ),
  end_agg as (
    select * from live_agg where p_to >= public.almaty_today()
    union all
    select * from last_snap where p_to < public.almaty_today()
  ),
  -- Запасной вариант среднего, если снимков за период нет: остаток на сегодня.
  current_agg as (
    select
      coalesce(top_category, 'Без категории') as category,
      sum(stock * buy_price) as stock_value,
      sum(stock * coalesce(sale_price, 0)) as stock_sale_value
    from public.moysklad_product_stock
    where store = any(p_stores)
      and buy_price is not null
      and stock > 0
    group by coalesce(top_category, 'Без категории')
  ),
  stock_agg as (
    select * from snap_agg where (select n from snap_days) > 0
    union all
    select * from current_agg where (select n from snap_days) = 0
  )
  select
    coalesce(c.category, st.category, e.category) as category,
    coalesce(c.cogs, 0) as cogs,
    coalesce(st.stock_value, 0) as stock_value,
    coalesce(c.revenue, 0) as revenue,
    coalesce(st.stock_sale_value, 0) as stock_sale_value,
    coalesce(e.stock_value, 0) as stock_value_end,
    coalesce(e.stock_sale_value, 0) as stock_sale_value_end
  from cogs_agg c
  full outer join stock_agg st on st.category = c.category
  full outer join end_agg e on e.category = coalesce(c.category, st.category)
$$;
