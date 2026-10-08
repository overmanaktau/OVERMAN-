-- Склад → «По поставщикам»: оборачиваемость в разрезе поставщика.
-- Оборачиваемость = себестоимость проданного за период ÷ себестоимость остатка на сегодня × 100 %.
-- Остаток по поставщику берётся на сегодня: ежедневные снимки остатков в базе хранятся по складу и
-- категории, без поставщика, поэтому средний остаток за период по поставщику посчитать нельзя.
create or replace function public.stock_turnover_by_supplier(p_stores text[], p_from date, p_to date)
returns table (supplier_name text, cogs numeric, stock_value numeric)
language sql
stable
as $$
  with c as (
    select coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name, sum(s.cost) as cogs
    from public.moysklad_product_sales_daily s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.sale_date between p_from and p_to
      and s.store = any(p_stores)
    group by 1
  ),
  st as (
    select coalesce(nullif(trim(p.supplier), ''), 'Без поставщика') as supplier_name,
           sum(s.stock * coalesce(s.buy_price, 0)) as stock_value
    from public.moysklad_product_stock s
    left join public.moysklad_products p on p.id = s.product_ms_id
    where s.stock > 0 and s.store = any(p_stores)
    group by 1
  )
  select supplier_name, coalesce(c.cogs, 0), coalesce(st.stock_value, 0)
  from c full outer join st using (supplier_name)
$$;

grant execute on function public.stock_turnover_by_supplier(text[], date, date) to authenticated;
