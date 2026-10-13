-- Роли для общих входов кассы: «Касса Актау» и «Касса Актобе». В каждой только раздел «Клиенты и сертификаты»
-- (overman.kz/client) с правом редактирования и доступ только к своему городу. Сами входы (аккаунты) заводятся в
-- «Настройки → Сотрудники»: на каждую кассу один общий аккаунт с такой ролью.
do $$
declare
  r_aktau bigint;
  r_aktobe bigint;
begin
  select id into r_aktau from public.roles where name = 'Касса Актау' and not is_personal;
  if r_aktau is null then
    insert into public.roles (name, is_personal) values ('Касса Актау', false) returning id into r_aktau;
    insert into public.role_permissions (role_id, section, can_view, can_edit) values (r_aktau, 'kassa', true, true);
    insert into public.role_store_access (role_id, scope, city_id) values (r_aktau, 'city', 1);
  end if;

  select id into r_aktobe from public.roles where name = 'Касса Актобе' and not is_personal;
  if r_aktobe is null then
    insert into public.roles (name, is_personal) values ('Касса Актобе', false) returning id into r_aktobe;
    insert into public.role_permissions (role_id, section, can_view, can_edit) values (r_aktobe, 'kassa', true, true);
    insert into public.role_store_access (role_id, scope, city_id) values (r_aktobe, 'city', 2);
  end if;
end $$;
