import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { telegramTransport } from "@/lib/coach/bot";
import { SCOPES, buildIntradayReport } from "@/lib/reports/sales";

export const maxDuration = 120;

// Отправить отчёт «данные до N:00» за выбранные дни лично сотруднику через бота-помощника
// (не в группы). Только с CRON_SECRET: ?user=<id в coach_users>&scope=point_1&dates=2026-10-05,2026-10-06&until=17.
// Каждый день — отдельным сообщением.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("user"));
  const scope = SCOPES[url.searchParams.get("scope") ?? ""];
  const dates = (url.searchParams.get("dates") ?? "").split(",").filter(Boolean);
  const until = Number(url.searchParams.get("until") ?? 17);
  if (!userId || !scope || dates.length === 0 || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d)) || !Number.isInteger(until) || until < 11 || until > 23) {
    return NextResponse.json({ error: "Неверные параметры." }, { status: 400 });
  }
  try {
    const { data: user, error } = await supabaseAdmin.from("coach_users").select("telegram_chat_id, employee_name").eq("id", userId).eq("status", "approved").maybeSingle();
    if (error) throw error;
    if (!user) return NextResponse.json({ error: "Пользователь не найден." }, { status: 404 });
    const sent: string[] = [];
    for (const date of dates) {
      for (const message of await buildIntradayReport(scope, date, until)) await telegramTransport.send(user.telegram_chat_id, message);
      sent.push(date);
    }
    return NextResponse.json({ to: user.employee_name, sent });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
