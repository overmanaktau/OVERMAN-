// «Тестовый сотрудник»: 30 минут после подтверждения, потом выход автоматически.
// Цифры в тестовом режиме условные — настоящие данные сотрудников не показываются.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { REMOVE_KEYBOARD, type Transport } from "@/lib/coach/bot";
import {
  type EmployeeRef,
  type MonthStatus,
  type WeekSummary,
  addDays,
  buildAdvice,
  daysBetween,
  monthEndOf,
  monthStartOf,
  mondayOf,
} from "@/lib/coach/metrics";
import { dailyMessage, weekMessage } from "@/lib/coach/messages";

export const TEST_EMPLOYEE_ID = "test-employee";
export const TEST_MINUTES = 30;
export const TEST_LABEL = "🧪 Тестовый сотрудник";

export const TEST_WARNING =
  `⚠️ Это тестовый аккаунт: он живёт ${TEST_MINUTES} минут. После этого система сама выведет вас из него, и регистрацию нужно будет пройти заново. Цифры здесь условные.`;

export const TEST_EXPIRED_TEXT =
  `Время тестового аккаунта (${TEST_MINUTES} минут) закончилось, система вывела вас из него. Спасибо, что посмотрели! Чтобы войти снова, нажмите /start.`;

export const TEST_BANNER = "🧪 <i>Тестовый режим: цифры условные</i>\n\n";

export function testExpiresAt(): string {
  return new Date(Date.now() + TEST_MINUTES * 60_000).toISOString();
}

export function isTestExpired(u: { is_test?: boolean | null; status: string; test_expires_at?: string | null }): boolean {
  return !!u.is_test && u.status === "approved" && !!u.test_expires_at && new Date(u.test_expires_at).getTime() <= Date.now();
}

// Выводит одного тестового пользователя и сообщает ему об этом.
export async function expireTestUser(u: { id: number; telegram_chat_id: number }, t: Transport): Promise<void> {
  const { error } = await supabaseAdmin
    .from("coach_users")
    .update({ status: "left", left_at: new Date().toISOString(), test_expires_at: null })
    .eq("id", u.id)
    .eq("status", "approved");
  if (error) throw error;
  try {
    await t.send(u.telegram_chat_id, TEST_EXPIRED_TEXT, REMOVE_KEYBOARD);
  } catch (e) {
    console.error("coach test expire notify error:", getErrorMessage(e));
  }
}

// ---- Условные данные для тестового консультанта ----

// Образцы того, что настоящий стилист-консультант получает сам: утреннее сообщение после смены
// и понедельничное с планом на неделю и итогами прошлой. Показываются сразу после подтверждения.
export function demoAutoMessages(today: string): string[] {
  const emp: EmployeeRef = { id: TEST_EMPLOYEE_ID, name: "Тестовый консультант", store: "point_1" };
  const s = demoMonthStatus(today);
  const yesterday = addDays(today, -1);
  const day = { date: yesterday, revenue: 235_000, receipts: 7, items: 14 };
  return [
    `${TEST_BANNER}<b>Образец: сообщение, которое приходит утром после смены</b>\n\n${dailyMessage(emp, yesterday, day, s, buildAdvice(s))}`,
    `${TEST_BANNER}<b>Образец: сообщение, которое приходит по понедельникам</b>\n\n${weekMessage(emp, demoWeekSummary(today), true)}`,
  ];
}

export function demoMonthStatus(today: string): MonthStatus {
  const plan = 6_000_000;
  const fact = 2_400_000;
  const remainingDays = daysBetween(today, monthEndOf(today)) + 1;
  const monthStart = monthStartOf(today);
  const first = Number(today.slice(8, 10)) <= 15;
  const period = first
    ? { from: monthStart, to: `${monthStart.slice(0, 8)}15`, percent: 55, plan: 3_300_000, fact, needPerShift: 150_000 }
    : { from: `${monthStart.slice(0, 8)}16`, to: monthEndOf(today), percent: 45, plan: 2_700_000, fact: 1_100_000, needPerShift: 160_000 };
  return {
    today,
    plan,
    fact,
    pct: (fact / plan) * 100,
    remainingDays,
    deficit: plan - fact,
    remainingShifts: 12,
    needPerShift: (plan - fact) / 12,
    shifts28: 20,
    perShift: { revenue: 210_000, receipts: 6.5, avgCheck: 32_300, depth: 1.9 },
    recent: { revenue: 195_000, receipts: 5.8, avgCheck: 33_500, depth: 1.85 },
    period,
  };
}

export function demoWeekSummary(today: string): WeekSummary {
  const monday = mondayOf(today);
  return {
    monday,
    lastWeek: { from: addDays(monday, -7), to: addDays(monday, -1), plan: 1_400_000, fact: 1_250_000, shortfall: 150_000, receipts: 40, items: 76, shifts: 5 },
    thisWeek: {
      from: monday,
      to: addDays(monday, 6),
      base: 1_400_000,
      extra: 60_000,
      target: 1_460_000,
      factSoFar: 520_000,
      remaining: 940_000,
      perShift: 292_000,
      need: { own: { revenue: 210_000, receipts: 6.5, avgCheck: 32_300, depth: 1.9 }, perShift: 292_000 },
    },
  };
}
