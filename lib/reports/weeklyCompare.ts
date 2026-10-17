// Сравнение двух недель по дням (оборот, посетители, чеки, товары, средний чек, выполнение плана,
// конверсия, глубина чека) и PDF в виде таблицы, как у владельца в Google-таблице. Каждый понедельник в 9:00
// бот-помощник присылает его администратору города (Картбаев Нуржан).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { addDays, mondayOf } from "@/lib/coach/metrics";
import { addDaysYmd, dayPlanForDate, mondayYmd, remainingAddOn, type PlanLookup } from "@/lib/dayPlan";

export type CompareDay = {
  date: string;
  planRevenue: number;
  addOn?: number; // недобор месяца на этот день (только для сегодня и будущих дней и только при withDeficit; в PDF не показывается)
  planTraffic: number;
  revenue: number;
  visitors: number;
  receipts: number;
  items: number;
};
// monthPlan — план месяца города (сумма планов продавцов) для месяца начала периода; нужен итогам «Продажи и план» в боте.
export type CompareWeek = { from: string; to: string; days: CompareDay[]; monthPlan?: number };

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
export const MONTH = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

// Какая это неделя месяца: неделя (пн–вс) относится к месяцу своего четверга; номер — по числу четверга
// (1–7 — первая неделя, 8–14 — вторая и т.д.). Так неделя 28.09–04.10 — 1-я неделя октября.
export function weekOfMonth(mondayYmd: string): { n: number; month: number } {
  const thursday = addDays(mondayYmd, 3);
  return { n: Math.floor((Number(thursday.slice(8, 10)) - 1) / 7) + 1, month: Number(thursday.slice(5, 7)) - 1 };
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
export function weekdayOf(date: string) {
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

type PeriodRow = { plan_month: string; p1_from: string | null; p1_to: string | null; p1_percent: number | null; p2_from: string | null; p2_to: string | null; p2_percent: number | null };

// Один период любой длины (от from до to включительно): по дням — продажи, трафик и планы города.
// useOverrides=false — план дня только по правилу долей (как в окне «План продаж» на портале), без цифр, внесённых вручную для PDF.
// withDeficit=true — для сегодняшних и будущих дней считается ещё и недобор месяца (addOn): бот показывает «план + недобор». По умолчанию
// (PDF «Сравнение недель») недобора нет: PDF показывает план по долям дней недели как он есть (решение владельца 17.10.2026).
export async function loadPeriod(store: string, from: string, to: string, useOverrides = true, withDeficit = false): Promise<CompareWeek> {
  // планы нужны за все недели периода целиком (неделя может начинаться в прошлом месяце и заканчиваться в следующем)
  const planFrom = `${mondayYmd(from).slice(0, 7)}-01`;
  const planTo = addDaysYmd(mondayYmd(to), 6);
  // план дня зависит от факта с начала месяца (недобор месяца делится на оставшиеся дни) — продажи берём с 1-го числа месяца начала периода
  const factFrom = withDeficit ? `${from.slice(0, 7)}-01` : from;
  const todayYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const regRes = await supabaseAdmin.from("moysklad_registers").select("id").eq("store", store);
  if (regRes.error) throw regRes.error;
  const registerIds = (regRes.data ?? []).map((r) => r.id as string);

  const [salesRes, trafficRes, plansRes, periodsRes, overridesRes] = await Promise.all([
    registerIds.length
      ? supabaseAdmin.from("moysklad_sales_daily").select("sale_date, revenue, receipts_count, items_count").in("register_id", registerIds).gte("sale_date", factFrom).lte("sale_date", to).limit(5000)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("traffic_entries").select("entry_date, traffic_fact, traffic_plan").eq("store", store).gte("entry_date", from).lte("entry_date", to).limit(5000),
    supabaseAdmin.from("sales_plan_monthly").select("plan_month, sales_plan").eq("store", store).gte("plan_month", planFrom).lte("plan_month", planTo),
    supabaseAdmin.from("sales_plan_periods").select("*").eq("store", store).gte("plan_month", planFrom).lte("plan_month", planTo),
    // план оборота, внесённый вручную только для этого отчёта (главнее расчёта по плану месяца)
    supabaseAdmin.from("weekly_report_plan_overrides").select("plan_date, revenue_plan").eq("store", store).gte("plan_date", mondayYmd(from)).lte("plan_date", planTo),
  ]);
  if (salesRes.error) throw salesRes.error;
  if (trafficRes.error) throw trafficRes.error;
  if (plansRes.error) throw plansRes.error;
  if (periodsRes.error) throw periodsRes.error;
  if (overridesRes.error) throw overridesRes.error;

  const sales = new Map<string, { revenue: number; receipts: number; items: number }>();
  for (const r of (salesRes.data ?? []) as { sale_date: string; revenue: number; receipts_count: number; items_count: number }[]) {
    const a = sales.get(r.sale_date) ?? { revenue: 0, receipts: 0, items: 0 };
    a.revenue += Number(r.revenue) || 0;
    a.receipts += Number(r.receipts_count) || 0;
    a.items += Number(r.items_count) || 0;
    sales.set(r.sale_date, a);
  }
  const traffic = new Map<string, { fact: number; plan: number }>();
  for (const r of (trafficRes.data ?? []) as { entry_date: string; traffic_fact: number | null; traffic_plan: number | null }[]) {
    traffic.set(r.entry_date, { fact: Number(r.traffic_fact) || 0, plan: Number(r.traffic_plan) || 0 });
  }
  const monthPlans = new Map<string, number>();
  for (const r of (plansRes.data ?? []) as { plan_month: string; sales_plan: number | null }[]) {
    monthPlans.set(r.plan_month, (monthPlans.get(r.plan_month) ?? 0) + (Number(r.sales_plan) || 0));
  }
  const overrides = new Map<string, number>();
  for (const r of (overridesRes.data ?? []) as { plan_date: string; revenue_plan: number }[]) overrides.set(r.plan_date, Number(r.revenue_plan) || 0);
  const periods = new Map<string, PeriodRow>();
  for (const r of (periodsRes.data ?? []) as PeriodRow[]) periods.set(r.plan_month, r);

  const lookup: PlanLookup = {
    dayOverride: useOverrides ? (d) => overrides.get(d) : undefined,
    monthPlan: (m) => monthPlans.get(m) ?? 0,
    periods: (m) => {
      const row = periods.get(m);
      if (!row) return null;
      return [
        { from: row.p1_from, to: row.p1_to, percent: row.p1_percent },
        { from: row.p2_from, to: row.p2_to, percent: row.p2_percent },
      ]
        .filter((c): c is { from: string; to: string; percent: number | null } => !!c.from && !!c.to)
        .map((c) => ({ from: c.from, to: c.to, percent: Number(c.percent) || 0 }));
    },
  };
  return {
    from,
    to,
    monthPlan: monthPlans.get(`${from.slice(0, 7)}-01`) ?? 0,
    days: Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => {
      const date = addDays(from, i);
      const s = sales.get(date);
      const t = traffic.get(date);
      return {
        date,
        planRevenue: (useOverrides ? overrides.get(date) : undefined) ?? dayPlanForDate(store, date, lookup),
        addOn: withDeficit ? remainingAddOn(store, date, lookup, (d) => sales.get(d)?.revenue ?? 0, todayYmd) : 0,
        planTraffic: t?.plan ?? 0,
        revenue: s?.revenue ?? 0,
        visitors: t?.fact ?? 0,
        receipts: s?.receipts ?? 0,
        items: s?.items ?? 0,
      };
    }),
  };
}

// Два произвольных периода одного города (для отчёта «Сравнение периодов» в боте).
export async function loadPeriodsCompare(store: string, p1: { from: string; to: string }, p2: { from: string; to: string }): Promise<{ weeks: [CompareWeek, CompareWeek]; city: string }> {
  const [a, b] = await Promise.all([loadPeriod(store, p1.from, p1.to), loadPeriod(store, p2.from, p2.to)]);
  return { weeks: [a, b], city: CITY[store] ?? store };
}

// Две подряд идущие недели (пн–вс). weekFrom — понедельник первой недели; по умолчанию — две последние
// полностью прошедшие недели.
export async function loadWeeklyCompare(store: string, today: string, weekFrom?: string): Promise<{ weeks: [CompareWeek, CompareWeek]; city: string }> {
  const lastMonday = mondayOf(today);
  const w1 = weekFrom ?? addDays(lastMonday, -14);
  const w2 = addDays(w1, 7);
  return loadPeriodsCompare(store, { from: w1, to: addDays(w1, 6) }, { from: w2, to: addDays(w2, 6) });
}

// ───────── расчёты и оформление ─────────

export type Totals = Omit<CompareDay, "date">;
export const sumDays = (days: CompareDay[]): Totals =>
  days.reduce<Totals>(
    (a, d) => ({
      planRevenue: a.planRevenue + d.planRevenue,
      planTraffic: a.planTraffic + d.planTraffic,
      revenue: a.revenue + d.revenue,
      visitors: a.visitors + d.visitors,
      receipts: a.receipts + d.receipts,
      items: a.items + d.items,
    }),
    { planRevenue: 0, planTraffic: 0, revenue: 0, visitors: 0, receipts: 0, items: 0 }
  );

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
export const int = (n: number) => nf0.format(Math.round(n)).replace(/[  ]/g, " ");
export const dec = (n: number, d: number) => n.toFixed(d).replace(".", ",");
export const pct = (n: number, d = 2) => `${dec(n, d)}%`;
export const signed = (n: number, f: (x: number) => string) => (n > 0 ? `+${f(n)}` : f(n));

export const ratios = (t: Totals) => ({
  atv: t.receipts > 0 ? t.revenue / t.receipts : 0,
  revPct: t.planRevenue > 0 ? (t.revenue / t.planRevenue) * 100 : null,
  trafPct: t.planTraffic > 0 ? (t.visitors / t.planTraffic) * 100 : null,
  cr: t.visitors > 0 ? (t.receipts / t.visitors) * 100 : 0,
  depth: t.receipts > 0 ? t.items / t.receipts : 0,
});

type Fonts = { regular: string; bold: string };
export async function loadFonts(): Promise<Fonts> {
  const get = async (name: string) => {
    try {
      return (await readFile(path.join(process.cwd(), "public", "fonts", "pdf", name))).toString("base64");
    } catch {
      const res = await fetch(`https://www.overman.kz/fonts/pdf/${name}`);
      if (!res.ok) throw new Error(`Шрифт ${name} недоступен.`);
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    }
  };
  const [regular, bold] = await Promise.all([get("NotoSans-Regular.ttf"), get("NotoSans-Bold.ttf")]);
  return { regular, bold };
}

// Подписи PDF. Для недельного отчёта вычисляются сами (номера недель месяца); для произвольных периодов задаются снаружи.
export type CompareLabels = {
  title: string; // «Сравнение периодов · Актау»
  subtitle: string; // под заголовком: какие периоды
  bands: [string, string]; // заголовки блоков (над днями каждого периода)
  diff: string; // подпись строки разницы
  dayAsDate: boolean; // в первой колонке «05.10» вместо «5» — для периодов, которые не укладываются в одну неделю или месяц
};

// PDF в альбомной ориентации: два периода (по умолчанию две недели) по дням, итоги и разница второго от первого.
// Оформление («тепловая карта») — в weeklyCompareStyled; подгружается по требованию, чтобы файлы не зависели друг от друга при загрузке.
export async function buildWeeklyComparePdf(weeks: [CompareWeek, CompareWeek], city: string, custom?: CompareLabels): Promise<Uint8Array> {
  const { buildStyledComparePdf } = await import("@/lib/reports/weeklyCompareStyled");
  return buildStyledComparePdf(weeks, city, custom);
}
