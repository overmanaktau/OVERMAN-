-- Дата, с которой считается личный план сотрудника на месяц (стажёр пришёл в середине месяца): до неё план дня 0, план делится на дни с этой даты.
alter table public.sales_plan_monthly add column if not exists plan_from date;
