-- Дневной план оборота по Актобе на конец сентября — только для PDF «Сравнение недель» (в портале плана за эти дни нет).
insert into public.weekly_report_plan_overrides (store, plan_date, revenue_plan) values
  ('point_3', '2026-09-28', 283333),
  ('point_3', '2026-09-29', 283333),
  ('point_3', '2026-09-30', 283333)
on conflict (store, plan_date) do update set revenue_plan = excluded.revenue_plan;
