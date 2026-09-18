# Overman — портал бизнеса

Каркас портала на Next.js + Tailwind, дизайн перенесён 1:1 из
макета (сайдбар, цвета, шрифты Newsreader/Manrope). Сейчас работают
два экрана раздела «Маркетинг»: **Статистика** (демо-данные) и
**Внесение данных** (реально редактируемая таблица за месяц, хранится
пока только в состоянии React — подключение к базе данных это
следующий этап).

## Запуск локально

Нужен установленный Node.js 18+.

```bash
npm install
npm run dev
```

Откройте http://localhost:3000 — попадёте на `/marketing/statistics`.

## Структура

```
app/
  layout.tsx                     — шрифты, общий <html>/<body>
  page.tsx                       — редирект на /marketing/statistics
  marketing/
    layout.tsx                   — сайдбар + рамка контента
    statistics/page.tsx          — экран «Статистика»
    data-entry/page.tsx          — экран «Внесение данных»
    publications/page.tsx        — заглушка
    instagram-target/page.tsx    — заглушка
components/
  Sidebar.tsx
  KpiCard.tsx
lib/
  supabaseClient.ts              — заготовка для этапа 2
tailwind.config.ts               — все цвета/шрифты дизайна в одном месте
```

## Как выложить в свой GitHub

```bash
git init
git add .
git commit -m "Overman portal: scaffold + Marketing screens"
```

Затем на github.com создайте пустой репозиторий (без README) и:

```bash
git remote add origin https://github.com/<ваш-аккаунт>/overman-portal.git
git branch -M main
git push -u origin main
```

## Дальше — этап 2

1. Завести проект на supabase.com, создать таблицы
   `traffic_entries`, `extra_expenses`, `month_status`, `users_roles`.
2. Заполнить `.env.local` (по образцу `.env.local.example`).
3. В `lib/supabaseClient.ts` раскомментировать клиент.
4. В `app/marketing/data-entry/page.tsx` заменить локальный
   `useState` на чтение/запись через Supabase и включить Row Level
   Security, чтобы редактировать закрытый месяц мог только `admin`.
5. Импортировать репозиторий на vercel.com → Deploy → подключить
   домен overman.kz в настройках проекта.
