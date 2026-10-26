// Сборка текстов утренних сообщений стилистам: «итоги смены» и «новая неделя». Общий код для рассылки (7:15) и для выгрузки
// «сообщения за неделю» владельцу (тексты сообщений в базе не хранятся — при выгрузке они считаются заново на дату отправки).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { dailyMessage, weekMessage } from "@/lib/coach/messages";
import { addDays, buildAdvice, dayStats, employeeDayPlans, loadEmployeeDays, monthStatus, weekSummary, type EmployeeRef } from "@/lib/coach/metrics";
import { NO_CONVERSION_EMPLOYEE_IDS, pct2 } from "@/lib/reports/sales";

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

// «Итоги вашей смены» за вчера (относительно today); null — вчера у сотрудника не было смены.
export async function buildDailyText(emp: EmployeeRef, today: string): Promise<string | null> {
  const yesterday = addDays(today, -1);
  const day = await dayStats(emp, yesterday);
  if (!day) return null;
  const s = await monthStatus(emp, today);
  const traffic = (await cityTraffic(emp.store, yesterday, yesterday)).get(yesterday) ?? 0;
  const dayPlan = (await employeeDayPlans(emp, yesterday, yesterday).catch(() => []))[0]?.plan ?? null;
  return dailyMessage(emp, yesterday, day, s, buildAdvice(s), conversionText(emp.id, day.receipts, traffic), dayPlan);
}

// Понедельничное сообщение: цель на новую неделю и итоги прошлой.
export async function buildWeeklyText(emp: EmployeeRef, today: string): Promise<string> {
  const w = await weekSummary(emp, today);
  // конверсия прошлой недели: чеки ÷ трафик города только за дни смен сотрудника
  const shifts = (await loadEmployeeDays(emp.id, w.lastWeek.from, w.lastWeek.to)).filter((d) => d.receipts > 0 || d.revenue > 0);
  const trafficByDay = await cityTraffic(emp.store, w.lastWeek.from, w.lastWeek.to);
  const weekConv = conversionText(
    emp.id,
    shifts.reduce((a, d) => a + d.receipts, 0),
    shifts.reduce((a, d) => a + (trafficByDay.get(d.date) ?? 0), 0)
  );
  return weekMessage(emp, w, true, weekConv);
}
