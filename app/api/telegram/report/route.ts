import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { sendTelegramMessages } from "@/lib/telegram";
import { buildIntradayReport, buildPeriodReport, buildSalesReport, SCOPES, todayInAlmaty, yesterdayInAlmaty } from "@/lib/reports/sales";
import { REPORT_ROUTES } from "@/lib/reports/routes";
import { activeHoldFor, recordHeldReport, reportKindOf, reportRange } from "@/lib/verify/holds";
import { notifyOwner } from "@/lib/verify/notifyOwner";

export const maxDuration = 60;

// Ежедневная рассылка отчётов в группы Telegram. Дёргается по расписанию
// (pg_cron в Supabase) с CRON_SECRET, вручную — админом. ?dry=1 ничего не
// отправляет, а возвращает тексты; ?date=YYYY-MM-DD — отчёт за другой день, ?chat=<id> — только в одну группу,
// ?intraday=1 — дневной отчёт «сегодня, данные до N:00» (?until=17 по умолчанию, дата — сегодня), ?scope=point_1|point_3 — только отчёты этого города, ?force=1 — отправить, даже если отчёт удержан.
// Отчёт города удерживается (не уходит в группы), если ночная сверка нашла расхождение и автоисправление
// не помогло (см. lib/verify/holds.ts): неправильный отчёт отправлять нельзя, он уйдёт после исправления.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  const url = new URL(request.url);
  const intraday = url.searchParams.get("intraday") === "1";
  const untilHour = Number(url.searchParams.get("until") ?? 17);
  if (!Number.isInteger(untilHour) || untilHour < 11 || untilHour > 23) return NextResponse.json({ error: "Неверный until." }, { status: 400 });
  const date = url.searchParams.get("date") ?? (intraday ? todayInAlmaty() : yesterdayInAlmaty());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });
  const dry = url.searchParams.get("dry") === "1";
  const onlyChat = url.searchParams.get("chat");
  const onlyScope = url.searchParams.get("scope");
  const force = url.searchParams.get("force") === "1";
  // ?period=week|month — недельный/месячный отчёт, заканчивающийся днём `date`
  // (по умолчанию вчера: в понедельник это воскресенье, 1-го числа — последний
  // день прошлого месяца). Без period — обычный дневной отчёт.
  const periodParam = url.searchParams.get("period");
  if (periodParam && periodParam !== "week" && periodParam !== "month") {
    return NextResponse.json({ error: "Неверный period." }, { status: 400 });
  }
  const period = periodParam as "week" | "month" | null;

  const results: { chat: string; scope: string; messages: number; error?: string; preview?: string[]; held?: string }[] = [];
  const cache = new Map<string, string[]>();

  for (const route of REPORT_ROUTES) {
    if (onlyChat && route.chatId !== onlyChat) continue;
    for (const scopeKey of period ? route.periodScopes ?? [] : route.scopes) {
      const scope = SCOPES[scopeKey];
      if (!scope) continue;
      if (onlyScope && scopeKey !== onlyScope) continue;
      try {
        // Удержание: за период отчёта есть неисправленное расхождение этого города — не отправляем.
        if (!force && !dry && !intraday) {
          const kind = reportKindOf(periodParam);
          const hold = await activeHoldFor(scope.cityCodes, reportRange(kind, date));
          if (hold) {
            const isNew = await recordHeldReport(kind, date, scopeKey);
            if (isNew) {
              const names = { day: "Дневной", week: "Недельный", month: "Месячный" }[kind];
              await notifyOwner(
                `⏸ <b>${names} отчёт за ${date.split("-").reverse().join(".")} (${scope.title}) не отправлен</b>\nПричина: не исправлено расхождение за ${hold.check_date.split("-").reverse().join(".")}. Как только его исправят, отчёт уйдёт в группы сам.`
              );
            }
            results.push({ chat: route.label, scope: scopeKey, messages: 0, held: `расхождение за ${hold.check_date}` });
            continue;
          }
        }
        let messages = cache.get(scopeKey);
        if (!messages) {
          messages = intraday
            ? await buildIntradayReport(scope, date, untilHour)
            : period
              ? await buildPeriodReport(scope, period, date)
              : await buildSalesReport(scope, date);
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
