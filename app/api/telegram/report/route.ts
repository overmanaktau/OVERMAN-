import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { sendTelegramMessages } from "@/lib/telegram";
import { buildPeriodReport, buildSalesReport, SCOPES, yesterdayInAlmaty } from "@/lib/reports/sales";
import { REPORT_ROUTES } from "@/lib/reports/routes";

export const maxDuration = 60;

// Ежедневная рассылка отчётов в группы Telegram. Дёргается по расписанию
// (pg_cron в Supabase) с CRON_SECRET, вручную — админом. ?dry=1 ничего не
// отправляет, а возвращает тексты; ?date=YYYY-MM-DD — отчёт за другой день, ?chat=<id> — только в одну группу.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? yesterdayInAlmaty();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });
  const dry = url.searchParams.get("dry") === "1";
  const onlyChat = url.searchParams.get("chat");
  // ?period=week|month — недельный/месячный отчёт, заканчивающийся днём `date`
  // (по умолчанию вчера: в понедельник это воскресенье, 1-го числа — последний
  // день прошлого месяца). Без period — обычный дневной отчёт.
  const periodParam = url.searchParams.get("period");
  if (periodParam && periodParam !== "week" && periodParam !== "month") {
    return NextResponse.json({ error: "Неверный period." }, { status: 400 });
  }
  const period = periodParam as "week" | "month" | null;

  const results: { chat: string; scope: string; messages: number; error?: string; preview?: string[] }[] = [];
  const cache = new Map<string, string[]>();

  for (const route of REPORT_ROUTES) {
    if (onlyChat && route.chatId !== onlyChat) continue;
    for (const scopeKey of period ? route.periodScopes ?? [] : route.scopes) {
      const scope = SCOPES[scopeKey];
      if (!scope) continue;
      try {
        let messages = cache.get(scopeKey);
        if (!messages) {
          messages = period ? await buildPeriodReport(scope, period, date) : await buildSalesReport(scope, date);
          cache.set(scopeKey, messages);
        }
        if (dry) {
          results.push({ chat: route.label, scope: scopeKey, messages: messages.length, preview: messages });
        } else {
          await sendTelegramMessages(route.chatId, messages);
          results.push({ chat: route.label, scope: scopeKey, messages: messages.length });
        }
      } catch (e) {
        results.push({ chat: route.label, scope: scopeKey, messages: 0, error: getErrorMessage(e) });
      }
    }
  }

  const failed = results.some((r) => r.error);
  return NextResponse.json({ date, dry, results }, { status: failed ? 500 : 200 });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
