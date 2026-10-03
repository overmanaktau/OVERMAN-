// Расчёты бота-помощника для продавцов: план/факт по сотруднику, что повысить,
// цель на неделю. Всё считается по данным портала: план продавца на месяц из
// «Внесения плана продаж по сотрудникам» (sales_plan_monthly, периоды —
// sales_plan_periods), факт — из moysklad_employee_sales_daily.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type EmployeeRef = { id: string; name: string; store: string };

// ---- Даты (строки YYYY-MM-DD, считаем по UTC-датам — без часовых поясов) ----

export function todayInAlmaty(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
}
function parse(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(date: string, n: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}
export function monthStartOf(date: string): string {
  return `${date.slice(0, 8)}01`;
}
export function daysInMonthOf(date: string): number {
  const d = parse(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}
export function monthEndOf(date: string): string {
  return `${date.slice(0, 8)}${String(daysInMonthOf(date)).padStart(2, "0")}`;
}
export function mondayOf(date: string): string {
  const dow = parse(date).getUTCDay(); // 0 — воскресенье
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86400000);
}
export function shortDate(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

// ---- Загрузка данных ----

export type DayRow = { date: string; revenue: number; receipts: number; items: number };

export async function loadEmployeeDays(employeeId: string, from: string, to: string): Promise<DayRow[]> {
  const { data, error } = await supabaseAdmin
    .from("moysklad_employee_sales_daily")
    .select("sale_date, revenue, receipts_count, items_count")
    .eq("employee_ms_id", employeeId)
    .gte("sale_date", from)
    .lte("sale_date", to);
  if (error) throw error;
  const byDate = new Map<string, DayRow>();
  for (const r of (data ?? []) as { sale_date: string; revenue: number; receipts_count: number; items_count: number }[]) {
    const row = byDate.get(r.sale_date) ?? { date: r.sale_date, revenue: 0, receipts: 0, items: 0 };
    row.revenue += Number(r.revenue) || 0;
    row.receipts += Number(r.receipts_count) || 0;
    row.items += Number(r.items_count) || 0;
    byDate.set(r.sale_date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Дни, когда у сотрудника была смена (есть продажа): по ним считаем «за смену».
function isShift(d: DayRow): boolean {
  return d.receipts > 0 || d.revenue > 0;
}

async function loadMonthPlans(emp: EmployeeRef, months: string[]): Promise<Map<string, number | null>> {
  const unique = [...new Set(months)];
  const { data, error } = await supabaseAdmin
    .from("sales_plan_monthly")
    .select("plan_month, sales_plan")
    .eq("store", emp.store)
    .eq("employee_ms_id", emp.id)
    .in("plan_month", unique);
  if (error) throw error;
  const map = new Map<string, number | null>(unique.map((m) => [m, null]));
  for (const r of (data ?? []) as { plan_month: string; sales_plan: number | null }[]) {
    map.set(r.plan_month, r.sales_plan === null ? null : Number(r.sales_plan));
  }
  return map;
}

type PeriodsRow = {
  p1_from: string | null;
  p1_to: string | null;
  p1_percent: number | null;
  p2_from: string | null;
  p2_to: string | null;
  p2_percent: number | null;
};

async function loadPeriods(store: string, month: string): Promise<PeriodsRow | null> {
  const { data, error } = await supabaseAdmin
    .from("sales_plan_periods")
    .select("p1_from, p1_to, p1_percent, p2_from, p2_to, p2_percent")
    .eq("store", store)
    .eq("plan_month", month)
    .maybeSingle();
  if (error) throw error;
  return (data as PeriodsRow | null) ?? null;
}

// ---- Статус месяца ----

export type Benchmarks = { avgCheck: number; depth: number; receiptsPerShift: number } | null;

export type MonthStatus = {
  today: string;
  plan: number | null;
  fact: number; // факт с 1-го числа по вчера (сегодняшних продаж в данных ещё нет)
  pct: number | null;
  remainingDays: number; // от сегодня до конца месяца, считая сегодняшний
  deficit: number; // сколько осталось закрыть
  remainingShifts: number; // сколько смен ещё ожидается (по привычному графику)
  needPerShift: number | null;
  // Привычный темп за последние 28 дней (на смену)
  shifts28: number;
  perShift: { revenue: number; receipts: number; avgCheck: number; depth: number } | null;
  store: Benchmarks;
  period: {
    from: string;
    to: string;
    percent: number;
    plan: number;
    fact: number;
    needPerShift: number | null;
  } | null;
};

async function storeBenchmarks(store: string, from: string, to: string): Promise<Benchmarks> {
  const { data, error } = await supabaseAdmin
    .from("moysklad_employee_sales_daily")
    .select("employee_ms_id, sale_date, revenue, receipts_count, items_count")
    .eq("store", store)
    .gte("sale_date", from)
    .lte("sale_date", to);
  if (error) throw error;
  let revenue = 0;
  let receipts = 0;
  let items = 0;
  const shifts = new Set<string>();
  for (const r of (data ?? []) as { employee_ms_id: string; sale_date: string; revenue: number; receipts_count: number; items_count: number }[]) {
    revenue += Number(r.revenue) || 0;
    receipts += Number(r.receipts_count) || 0;
    items += Number(r.items_count) || 0;
    if ((Number(r.receipts_count) || 0) > 0) shifts.add(`${r.employee_ms_id}|${r.sale_date}`);
  }
  if (receipts <= 0 || shifts.size === 0) return null;
  return { avgCheck: revenue / receipts, depth: items / receipts, receiptsPerShift: receipts / shifts.size };
}

export async function monthStatus(emp: EmployeeRef, today: string): Promise<MonthStatus> {
  const monthStart = monthStartOf(today);
  const yesterday = addDays(today, -1);
  const lookbackFrom = addDays(today, -28);

  const [plans, days28, monthDays, periods, benchmarks] = await Promise.all([
    loadMonthPlans(emp, [monthStart]),
    loadEmployeeDays(emp.id, lookbackFrom, yesterday),
    loadEmployeeDays(emp.id, monthStart, yesterday),
    loadPeriods(emp.store, monthStart),
    storeBenchmarks(emp.store, lookbackFrom, yesterday),
  ]);

  const plan = plans.get(monthStart) ?? null;
  const fact = monthDays.reduce((a, d) => a + d.revenue, 0);
  const remainingDays = daysBetween(today, monthEndOf(today)) + 1;
  const deficit = plan === null ? 0 : Math.max(0, plan - fact);

  const shiftDays = days28.filter(isShift);
  const shifts28 = shiftDays.length;
  const revenue28 = days28.reduce((a, d) => a + d.revenue, 0);
  const receipts28 = days28.reduce((a, d) => a + d.receipts, 0);
  const items28 = days28.reduce((a, d) => a + d.items, 0);
  const perShift =
    shifts28 > 0 && receipts28 > 0
      ? {
          revenue: revenue28 / shifts28,
          receipts: receipts28 / shifts28,
          avgCheck: revenue28 / receipts28,
          depth: items28 / receipts28,
        }
      : null;

  const shiftsPerWeek = shifts28 / 4;
  const remainingShifts = Math.max(1, Math.round((shiftsPerWeek * remainingDays) / 7));
  const needPerShift = plan === null ? null : deficit / remainingShifts;

  // Текущий период месяца (задаётся на точку: даты и процент от плана).
  let period: MonthStatus["period"] = null;
  if (plan !== null && periods) {
    const candidates = [
      { from: periods.p1_from, to: periods.p1_to, percent: periods.p1_percent },
      { from: periods.p2_from, to: periods.p2_to, percent: periods.p2_percent },
    ];
    const cur = candidates.find((c) => c.from && c.to && c.from <= today && today <= c.to);
    if (cur && cur.from && cur.to) {
      const percent = Number(cur.percent) || 0;
      const periodPlan = (plan * percent) / 100;
      const periodFact = monthDays.filter((d) => d.date >= cur.from! && d.date <= cur.to!).reduce((a, d) => a + d.revenue, 0);
      const daysLeftInPeriod = daysBetween(today, cur.to) + 1;
      const periodShifts = Math.max(1, Math.round((shiftsPerWeek * daysLeftInPeriod) / 7));
      period = {
        from: cur.from,
        to: cur.to,
        percent,
        plan: periodPlan,
        fact: periodFact,
        needPerShift: Math.max(0, periodPlan - periodFact) / periodShifts,
      };
    }
  }

  return {
    today,
    plan,
    fact,
    pct: plan && plan > 0 ? (fact / plan) * 100 : null,
    remainingDays,
    deficit,
    remainingShifts,
    needPerShift,
    shifts28,
    perShift,
    store: benchmarks,
    period,
  };
}

// ---- Что повысить ----

export type Advice = {
  closed: boolean;
  noPlan: boolean;
  noHistory: boolean;
  factor: number | null; // во сколько раз нужно поднять выручку за смену
  needPerShift: number | null;
  lagging: "receipts" | "avgCheck" | "depth" | null;
  rows: { label: string; now: string; storeAvg: string | null; need: string }[];
};

// Выручка за смену = чеков × средний чек (а средний чек = глубина × цена
// товара). Чтобы закрыть план, выручку за смену нужно поднять в R раз; можно
// только чеками, только средним чеком (через глубину) или понемногу тем и тем.
// «Что повысить» — тот показатель, который сильнее всего отстаёт от среднего по
// точке за последние 28 дней.
export function buildAdvice(s: MonthStatus): Advice {
  const base: Advice = { closed: false, noPlan: false, noHistory: false, factor: null, needPerShift: s.needPerShift, lagging: null, rows: [] };
  if (s.plan === null) return { ...base, noPlan: true };
  if (s.deficit <= 0) return { ...base, closed: true };
  if (!s.perShift || s.perShift.revenue <= 0) return { ...base, noHistory: true };

  const R = (s.needPerShift ?? 0) / s.perShift.revenue;
  const p = s.perShift;
  const b = s.store;
  const ratios: { key: "receipts" | "avgCheck" | "depth"; ratio: number }[] = b
    ? [
        { key: "receipts", ratio: p.receipts / b.receiptsPerShift },
        { key: "avgCheck", ratio: p.avgCheck / b.avgCheck },
        { key: "depth", ratio: p.depth / b.depth },
      ]
    : [];
  const lagging = ratios.length ? ratios.sort((a, c) => a.ratio - c.ratio)[0].key : "avgCheck";
  const both = Math.sqrt(R);

  return {
    ...base,
    factor: R,
    lagging,
    rows: [
      {
        label: "Чеков за смену",
        now: p.receipts.toFixed(1),
        storeAvg: b ? b.receiptsPerShift.toFixed(1) : null,
        need: `${(p.receipts * both).toFixed(1)} (или ${(p.receipts * R).toFixed(1)}, если только чеками)`,
      },
      {
        label: "Средний чек",
        now: `${Math.round(p.avgCheck).toLocaleString("ru-RU")} ₸`,
        storeAvg: b ? `${Math.round(b.avgCheck).toLocaleString("ru-RU")} ₸` : null,
        need: `${Math.round(p.avgCheck * both).toLocaleString("ru-RU")} ₸`,
      },
      {
        label: "Глубина чека",
        now: p.depth.toFixed(2),
        storeAvg: b ? b.depth.toFixed(2) : null,
        need: `${(p.depth * both).toFixed(2)}`,
      },
    ],
  };
}

// ---- Неделя ----

export type WeekSummary = {
  monday: string;
  lastWeek: {
    from: string;
    to: string;
    plan: number | null;
    fact: number;
    shortfall: number;
    receipts: number;
    items: number;
    shifts: number;
  };
  thisWeek: {
    from: string;
    to: string;
    base: number | null; // план недели: сумма дневных планов (из периодов месяца)
    extra: number; // доля недобора прошлой недели, приходящаяся на эту неделю
    target: number | null;
    factSoFar: number;
    remaining: number | null;
    perShift: number | null;
  };
};

// План на день берётся из плана, распределённого на периоды месяца: план
// продавца на месяц × процент периода ÷ число дней периода, для периода, в
// который попадает эта дата. Если периоды на этот месяц не заданы — средний
// день: план месяца ÷ число дней месяца. Недельный план — сумма планов семи дней.
// Недобор прошлой недели (план минус факт, если факт ниже) раскидывается ровно
// на оставшиеся дни месяца (с этого понедельника до конца месяца); та его часть,
// что приходится на дни новой недели, добавляется к цели недели.
export async function weekSummary(emp: EmployeeRef, today: string): Promise<WeekSummary> {
  const monday = mondayOf(today);
  const lastFrom = addDays(monday, -7);
  const lastTo = addDays(monday, -1);
  const thisTo = addDays(monday, 6);
  const months = [...new Set([monthStartOf(lastFrom), monthStartOf(lastTo), monthStartOf(monday), monthStartOf(thisTo)])];

  const [plans, periodsList, lastDays, thisDays, days28] = await Promise.all([
    loadMonthPlans(emp, months),
    Promise.all(months.map((m) => loadPeriods(emp.store, m))),
    loadEmployeeDays(emp.id, lastFrom, lastTo),
    loadEmployeeDays(emp.id, monday, addDays(today, -1) >= monday ? addDays(today, -1) : monday),
    loadEmployeeDays(emp.id, addDays(today, -28), addDays(today, -1)),
  ]);
  const periodsByMonth = new Map(months.map((m, i) => [m, periodsList[i]]));

  const planPerDay = (date: string): number | null => {
    const month = monthStartOf(date);
    const p = plans.get(month) ?? null;
    if (p === null) return null;
    const periods = periodsByMonth.get(month);
    if (!periods) return p / daysInMonthOf(date);
    const candidates = [
      { from: periods.p1_from, to: periods.p1_to, percent: periods.p1_percent },
      { from: periods.p2_from, to: periods.p2_to, percent: periods.p2_percent },
    ];
    const cur = candidates.find((c) => c.from && c.to && c.from <= date && date <= c.to);
    if (!cur || !cur.from || !cur.to) return 0; // дата вне заданных периодов
    const periodDays = daysBetween(cur.from, cur.to) + 1;
    return (p * (Number(cur.percent) || 0)) / 100 / periodDays;
  };
  const sumPlan = (from: string, to: string): number | null => {
    let total = 0;
    let any = false;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const v = planPerDay(d);
      if (v !== null) {
        total += v;
        any = true;
      }
    }
    return any ? total : null;
  };

  // С планом сравниваем только дни, на которые план есть (например, неделя на
  // стыке месяцев, когда на прошлый месяц план не вносили).
  const planned = (d: DayRow): boolean => planPerDay(d.date) !== null;
  const lastPlan = sumPlan(lastFrom, lastTo);
  const lastFact = lastDays.reduce((a, d) => a + d.revenue, 0);
  const lastFactPlanned = lastDays.filter(planned).reduce((a, d) => a + d.revenue, 0);
  const shortfall = lastPlan === null ? 0 : Math.max(0, lastPlan - lastFactPlanned);

  const base = sumPlan(monday, thisTo);
  const remainingInMonth = daysBetween(monday, monthEndOf(monday)) + 1;
  const weekDaysInMonth = Math.min(7, remainingInMonth);
  const extra = shortfall > 0 ? (shortfall * weekDaysInMonth) / remainingInMonth : 0;
  const target = base === null ? null : base + extra;
  const factSoFar = thisDays
    .filter((d) => d.date < today && (base === null || planned(d)))
    .reduce((a, d) => a + d.revenue, 0);
  const shiftsPerWeek = Math.max(1, Math.round(days28.filter(isShift).length / 4));

  return {
    monday,
    lastWeek: {
      from: lastFrom,
      to: lastTo,
      plan: lastPlan,
      fact: lastFact,
      shortfall,
      receipts: lastDays.reduce((a, d) => a + d.receipts, 0),
      items: lastDays.reduce((a, d) => a + d.items, 0),
      shifts: lastDays.filter(isShift).length,
    },
    thisWeek: {
      from: monday,
      to: thisTo,
      base,
      extra,
      target,
      factSoFar,
      remaining: target === null ? null : Math.max(0, target - factSoFar),
      perShift: target === null ? null : target / shiftsPerWeek,
    },
  };
}

// ---- Вчерашняя смена ----

export async function dayStats(emp: EmployeeRef, date: string): Promise<DayRow | null> {
  const rows = await loadEmployeeDays(emp.id, date, date);
  const row = rows[0];
  return row && isShift(row) ? row : null;
}
