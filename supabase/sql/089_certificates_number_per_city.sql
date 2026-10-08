-- Номер сертификата уникален внутри города: в Актау и Актобе номера могут совпадать
-- (сотрудник одного города чужой номер не находит).
drop index if exists public.certificates_number_unique;
create unique index if not exists certificates_number_per_store on public.certificates (store, lower(btrim(number)));
