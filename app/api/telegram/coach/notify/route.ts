import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { menuFor, telegramTransport } from "@/lib/coach/bot";
import { syncCoachNames } from "@/lib/coach/syncNames";
import { refOf, type CoachUser } from "@/lib/coach/handler";
import { dailyMessage, weekMessage } from "@/lib/coach/messages";
import { addDays, buildAdvice, dayStats, loadEmployeeDays, monthStatus, todayInAlmaty, weekSummary } from "@/lib/coach/metrics";
import { NO_CONVERSION_EMPLOYEE_IDS, pct2 } from "@/lib/reports/sales";

export const maxDuration = 60;

// Утренние сообщения продавцам (расписание pg_cron, 9:15 по Алматы):
//  · «итоги смены» — только тем, у кого ВЧЕРА были продажи (вышел на смену);
//    если смены не было, ничего не приходит;
//  · по понедельникам — всем подтверждённым недельный план и итоги прошлой
//    недели, независимо от того, выходил ли человек вчера.
// ?dry=1 — не отправлять, а вернуть тексты; ?date=YYYY-MM-DD — считать «как
// сегодня» другой день; ?user=<id> — только один продавец.
// Трафик города по дням (счётчик на входе) — знаменатель конверсии: чеки сотрудника ÷ трафик города за его смены.
async function cityTraffic(store: string, from: string, to: string): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin.from("traffic_entries").select("entry_date, traffic_fact").eq("store", store).gte("entry_date", from).lte("entry_date", to);
  if (error) throw error;
  const map = new Map<string, number>();
  for (const r of (data ?? []) as { entry_date: string; traffic_fact: number | null }[]) map.set(r.entry_date, (map.get(r.entry_date) ?? 0) + (Number(r.traffic_fact) || 0));
  return map;
}
// У «Болат Наргиза» конверсию не показываем (решение владельца); нет трафика — так и пишем.
function conversionText(employeeId: string, receipts: number, traffic: number): string | null {
  if (NO_CONVERSION_EMPLOYEE_IDS.has(employeeId)) return null;
  return traffic > 0 ? pct2((receipts / traffic) * 100) : "нет трафика";
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const dateParam = url.searchParams.get("date");
  const today = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayInAlmaty();
  const yesterday = addDays(today, -1);
  const isMonday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
  const onlyUser = url.searchParams.get("user");

  try {
    // Имена в сообщениях — как сейчас в МойСклад (сбой не мешает рассылке).
    await syncCoachNames().catch(() => null);
    let query = supabaseAdmin.from("coach_users").select("*").eq("status", "approved").eq("is_test", false).eq("is_admin", false);
    if (onlyUser) query = query.eq("id", Number(onlyUser));
    const { data, error } = await query;
    if (error) throw error;

    const results: { user: string; kind: string; action: string; text?: string }[] = [];

    async function deliver(user: CoachUser, kind: "daily" | "weekly", refDate: string, text: string) {
      const label = `${user.employee_name}`;
      if (dry) {
        results.push({ user: label, kind, action: "dry", text });
        return;
      }
      const { data: already } = await supabaseAdmin
        .from("coach_messages_sent")
        .select("id")
        .eq("user_id", user.id)
        .eq("kind", kind)
        .eq("ref_date", refDate)
        .maybeSingle();
      if (already) {
        results.push({ user: label, kind, action: "уже отправлено" });
        return;
      }
      try {
        await telegramTransport.send(user.telegram_chat_id, text, menuFor(user));
        await supabaseAdmin.from("coach_messages_sent").insert({ user_id: user.id, kind, ref_date: refDate });
        results.push({ user: label, kind, action: "отправлено" });
      } catch (e) {
        results.push({ user: label, kind, action: `ошибка: ${getErrorMessage(e)}` });
      }
    }

    for (const user of (data ?? []) as CoachUser[]) {
      const emp = refOf(user);
      try {
        const day = await dayStats(emp, yesterday);
        if (day) {
          const s = await monthStatus(emp, today);
          const traffic = (await cityTraffic(emp.store, yesterday, yesterday)).get(yesterday) ?? 0;
          await deliver(user, "daily", yesterday, dailyMessage(emp, yesterday, day, s, buildAdvice(s), conversionText(emp.id, day.receipts, traffic)));
        } else {
          results.push({ user: user.employee_name, kind: "daily", action: "не отправлено: вчера не было продаж" });
        }
        if (isMonday) {
          const w = await weekSummary(emp, today);
          // конверсия прошлой недели: чеки ÷ трафик города только за дни смен сотрудника
          const shifts = (await loadEmployeeDays(emp.id, w.lastWeek.from, w.lastWeek.to)).filter((d) => d.receipts > 0 || d.revenue > 0);
          const trafficByDay = await cityTraffic(emp.store, w.lastWeek.from, w.lastWeek.to);
          const weekConv = conversionText(
            emp.id,
            shifts.reduce((a, d) => a + d.receipts, 0),
            shifts.reduce((a, d) => a + (trafficByDay.get(d.date) ?? 0), 0)
          );
          await deliver(user, "weekly", today, weekMessage(emp, w, true, weekConv));
        }
      } catch (e) {
        results.push({ user: user.employee_name, kind: "расчёт", action: `ошибка: ${getErrorMessage(e)}` });
      }
    }

    return NextResponse.json({ ok: true, dry, today, isMonday, users: (data ?? []).length, results });
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
