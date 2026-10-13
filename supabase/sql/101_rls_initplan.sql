-- Ускорение базы: функции доступа в политиках RLS (has_access, is_admin, has_all_stores_access, has_finance_view, auth.uid())
-- вычислялись заново для КАЖДОЙ строки таблицы, из-за чего запросы по складу, АВС/XYZ и поставщикам занимали секунды.
-- Обёртка «(select …)» заставляет базу вычислить функцию один раз на запрос. Права доступа при этом не меняются — только скорость
-- (замер: АВС/XYZ 1163 → 9 мс, список складов 216 → 2 мс, по поставщикам 586 → 11 мс). Политики с has_store_access(колонка)
-- не трогаем: зависят от строки. Повторный запуск безопасен.
do $$
declare
  r record;
  q text;
  w text;
  fn constant text := '((?:public\.)?(?:has_access|has_all_stores_access|has_finance_view|is_admin)\([^()]*\))';
  done constant text := '\(\s*select\s+(public\.)?(has_access|has_all_stores_access|has_finance_view|is_admin|auth\.uid)';
  stmt text;
begin
  for r in select schemaname, tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    q := r.qual;
    w := r.with_check;
    if coalesce(q, '') ~* done or coalesce(w, '') ~* done then
      continue;
    end if;
    if q is not null then
      q := regexp_replace(regexp_replace(q, fn, '(select \1)', 'g'), 'auth\.uid\(\)', '(select auth.uid())', 'g');
    end if;
    if w is not null then
      w := regexp_replace(regexp_replace(w, fn, '(select \1)', 'g'), 'auth\.uid\(\)', '(select auth.uid())', 'g');
    end if;
    if q is not distinct from r.qual and w is not distinct from r.with_check then
      continue;
    end if;
    stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if q is not null then stmt := stmt || format(' using (%s)', q); end if;
    if w is not null then stmt := stmt || format(' with check (%s)', w); end if;
    execute stmt;
  end loop;
end $$;
