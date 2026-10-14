-- Новый запрос на правку данных (edit_requests) → сразу сообщение владельцу в Telegram с кнопками «Одобрить»/«Отклонить».
-- База после вставки вызывает адрес сайта (pg_net); ошибка вызова никогда не мешает сохранению самого запроса.
-- В файле вместо секрета стоит __NOTIFY_TOKEN__: настоящий токен (sha256("mswebhook:" + CRON_SECRET), первые 40 символов)
-- подставляется при применении и в репозиторий не попадает.
create or replace function public.notify_edit_request()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
begin
  begin
    perform net.http_post(
      url := 'https://www.overman.kz/api/edit-requests/notify?token=__NOTIFY_TOKEN__',
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 5000
    );
  exception when others then
    null;
  end;
  return new;
end;
$$;

drop trigger if exists edit_requests_notify on public.edit_requests;
create trigger edit_requests_notify
  after insert on public.edit_requests
  for each row execute function public.notify_edit_request();