-- Дневной план оборота, внесённый вручную только для PDF «Сравнение недель» (в разделе «Продажа»
-- и других местах портала не используется). Нужен там, где плана оборота в портале нет
-- (например, за конец сентября). Если на дату есть запись здесь — она главнее расчёта по плану месяца.
create table if not exists public.weekly_report_plan_overrides (
  store text not null references public.stores(code),
  plan_date date not null,
  revenue_plan numeric not null check (revenue_plan >= 0),
  created_at timestamptz not null default now(),
  primary key (store, plan_date)
);
alter table public.weekly_report_plan_overrides enable row level security;

insert into public.weekly_report_plan_overrides (store, plan_date, revenue_plan) values
  ('point_1', '2026-09-28', 800000),
  ('point_1', '2026-09-29', 800000),
  ('point_1', '2026-09-30', 900000)
on conflict (store, plan_date) do update set revenue_plan = excluded.revenue_plan;
