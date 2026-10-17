// Дневной план оборота города. Правило владельца (15.10.2026):
//  1. План месяца делится на два периода месяца (sales_plan_periods: конкретные даты и процент от месяца).
//  2. Средний план дня периода = план периода ÷ число дней периода (например, 1–15 октября: план периода ÷ 15).
//  3. План календарной недели (пн–вс) = сумма средних планов её семи дней; каждый день берёт среднее СВОЕГО периода — если неделя начинается
//     в прошлом месяце (1 октября — четверг), её пн, вт и ср берут средний план периода прошлого месяца, остальные дни — октябрьского.
//  4. План недели раскладывается по дням по долям дней недели: пн 11, вт 11, ср 11, чт 14, пт 17, сб 18, вс 18 (%). Доли посчитаны по реальным
//     продажам Актау (12 недель, 15.10.2026); Актобе — те же. Меняются только здесь, через владельца портала — на сайте их не поменять.
// День без плана (в его месяце план не внесён или он вне периодов) получает 0. Тот же расчёт используют портал (окно «План продаж»),
// PDF-отчёты и бот-помощник (недельные цели сотрудников) — чтобы цифры не расходились.
const CITY_SHARE = [11, 11, 11, 14, 17, 18, 18];
export const WEEKDAY_SHARE: Record<string, number[]> = {
  point_1: CITY_SHARE,
  point_3: CITY_SHARE,
};
const EQUAL = [1, 1, 1, 1, 1, 1, 1];

export type PlanPeriod = { from: string; to: string; percent: number };
// Откуда брать планы: monthPlan — план месяца (первое число месяца → сумма, 0 — не внесён); periods — периоды месяца (null — не заданы).
export type PlanLookup = {
  monthPlan: (monthStart: string) => number;
  periods: (monthStart: string) => PlanPeriod[] | null;
  // план конкретного дня, внесённый вручную (только для PDF «Сравнение недель»): заменяет средний план этого дня при расчёте плана недели
  dayOverride?: (date: string) => number | undefined;
};

export function addDaysYmd(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// 0 — понедельник … 6 — воскресенье
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
export function mondayYmd(date: string): string {
  return addDaysYmd(date, -weekdayIndex(date));
}
function daysBetweenYmd(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// Средний план одного дня: период, в который попадает день (план месяца × процент ÷ дни периода); без заданных периодов — план месяца ÷ дни месяца.
function avgDailyPlan(date: string, lk: PlanLookup): number {
  const manual = lk.dayOverride?.(date);
  if (manual !== undefined) return manual;
  const month = `${date.slice(0, 7)}-01`;
  const plan = lk.monthPlan(month);
  if (plan <= 0) return 0;
  const periods = lk.periods(month);
  if (!periods) {
    const [y, m] = date.split("-").map(Number);
    return plan / new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  const cur = periods.find((p) => p.from <= date && date <= p.to);
  return cur ? (plan * cur.percent) / 100 / (daysBetweenYmd(cur.from, cur.to) + 1) : 0;
}

// План дня: план недели этого дня (сумма средних планов семи дней недели) × доля дня недели.
export function dayPlanForDate(store: string, date: string, lk: PlanLookup): number {
  if (avgDailyPlan(date, lk) <= 0) return 0; // в месяце дня план не внесён или день вне периодов
  const monday = mondayYmd(date);
  let weekPlan = 0;
  for (let i = 0; i < 7; i++) weekPlan += avgDailyPlan(addDaysYmd(monday, i), lk);
  const shares = WEEKDAY_SHARE[store] ?? EQUAL;
  const shareSum = shares.reduce((a, v) => a + v, 0);
  return weekPlan * (shares[weekdayIndex(date)] / shareSum);
}

// ---- План дня и недобор месяца (правило владельца 17.10.2026) ----
// Базовый план дня (dayPlanForDate) — доля дня недели (это «фактический план»). Рядом через «+» показывается недобор месяца: недобор = план месяца − факт за прошлые дни − базовые
// планы оставшихся дней; он делится ПОРОВНУ на оставшиеся дни (считая сам день) и прибавляется к плану каждого из них. Тогда сумма планов
// оставшихся дней + факт прошлых дней = план месяца. «План + недобор» показывается везде, кроме PDF «Сравнение недель» (там только план).
// Для прошедшего дня считаем «как было утром этого дня» (по факту до него), для сегодняшнего и будущих дней — «как сегодня утром».
export type FactLookup = (date: string) => number; // выручка по дате (0, если данных нет)

function monthEndYmd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Добавка (может быть отрицательной, если месяц идёт с опережением) к базовому плану каждого дня месяца с точки зрения дня asOf.
export function planAddOn(store: string, date: string, lk: PlanLookup, fact: FactLookup, today: string): number {
  const month = `${date.slice(0, 7)}-01`;
  const monthPlan = lk.monthPlan(month);
  if (!(monthPlan > 0)) return 0;
  const end = monthEndYmd(date);
  let asOf = date < today ? date : today;
  if (asOf < month) asOf = month;
  let factBefore = 0;
  for (let d = month; d < asOf; d = addDaysYmd(d, 1)) factBefore += fact(d);
  let futureBase = 0;
  let n = 0;
  for (let d = asOf; d <= end; d = addDaysYmd(d, 1)) {
    const base = dayPlanForDate(store, d, lk);
    futureBase += base;
    if (base > 0) n++;
  }
  return n > 0 ? (monthPlan - factBefore - futureBase) / n : 0;
}

// Недобор для сегодняшнего и будущих дней: одинаковая добавка к плану каждого оставшегося дня (для прошедших дней 0). Показывается рядом с
// фактическим планом через «+» (владелец 17.10.2026: «покажи фактический план и через + недобор»); не меньше, чем −план дня.
export function remainingAddOn(store: string, date: string, lk: PlanLookup, fact: FactLookup, today: string): number {
  if (date < today) return 0;
  const base = dayPlanForDate(store, date, lk);
  if (base <= 0) return 0;
  return Math.max(-base, planAddOn(store, date, lk, fact, today));
}

