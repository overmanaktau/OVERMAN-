// Продавцы города за текущий месяц для руководителей (страница /seller): оборот, личный план, выполнение, ставка и «бонус сейчас»,
// прогноз, сегодня, неделя, чеки. Прошлые дни — из таблицы продаж по сотрудникам (ночное обновление), сегодняшний день — прямо из МойСклад.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchRetailDemandsForDate, fetchRetailSalesReturnsForDate } from "@/lib/moysklad";
import { aggregateSales } from "@/lib/salesAggregate";
import { addDays, daysInMonthOf, mondayOf, monthStartOf, todayInAlmaty } from "@/lib/coach/metrics";
import { bonusRate } from "@/lib/sellers/rate";

export type SellerRow = {
  id: string;
  name: string;
  turnover: number;
  plan: number | null;
  fulfillment: number | null; // %
  rate: number | null; // %
  bonus: number | null; // ₸, оборот × ставка
  forecastPct: number | null; // % к плану при текущем темпе
  today: number;
  week: number;
  receipts: number;
  depth: number | null; // глубина чека: товаров в чеке в среднем за месяц
};

export type CitySellers = {
  store: string;
  date: string; // сегодня (Алматы)
  day: number; // какой день месяца
  daysInMonth: number;
  team: { turnover: number; plan: number; fulfillment: number | null; forecast: number; forecastPct: number | null; today: number; week: number; receipts: number; avgCheck: number | null; depth: number | null };
  rows: SellerRow[];
  noSales: string[]; // есть в плане или в таблице, но продаж в этом месяце нет
  updatedAt: string; // ISO
};

// Продавцы, которых на странице не показываем (владелец): ни в таблице, ни в плане и итогах команды.
const HIDDEN = new Set([
  "a8605fa5-c2fe-11f1-0a80-02920050bab4", // Бекберген Бердібек
]);

type Acc = { name: string; turnover: number; week: number; today: number; receipts: number; items: number };

export async function citySellers(store: string): Promise<CitySellers> {
  const today = todayInAlmaty();
  const monthStart = monthStartOf(today);
  const yesterday = addDays(today, -1);
  const weekStart = mondayOf(today);
  const daysInMonth = daysInMonthOf(today);
  const day = Number(today.slice(8, 10));

  const people = new Map<string, Acc>();
  const get = (id: string, name: string) => {
    if (HIDDEN.has(id)) return { name, turnover: 0, week: 0, today: 0, receipts: 0, items: 0 }; // не сохраняем
    const p = people.get(id) ?? { name, turnover: 0, week: 0, today: 0, receipts: 0, items: 0 };
    if (name) p.name = name;
    people.set(id, p);
    return p;
  };

  // прошлые дни месяца (сегодняшнего в таблице нет)
  if (yesterday >= monthStart) {
    const { data, error } = await supabaseAdmin
      .from("moysklad_employee_sales_daily")
      .select("employee_ms_id, employee_name, sale_date, revenue, receipts_count, items_count")
      .eq("store", store)
      .gte("sale_date", monthStart)
      .lte("sale_date", yesterday);
    if (error) throw error;
    for (const r of (data ?? []) as { employee_ms_id: string; employee_name: string; sale_date: string; revenue: number; receipts_count: number; items_count: number }[]) {
      const p = get(r.employee_ms_id, r.employee_name);
      const rev = Number(r.revenue) || 0;
      p.turnover += rev;
      p.receipts += Number(r.receipts_count) || 0;
      p.items += Number(r.items_count) || 0;
      if (r.sale_date >= weekStart) p.week += rev;
    }
  }

  // сегодня — из МойСклад: чеки минус возвраты за сегодня, как в отчётах
  const [demands, returns] = await Promise.all([fetchRetailDemandsForDate(today), fetchRetailSalesReturnsForDate(today)]);
  const agg = await aggregateSales(today, demands, returns);
  for (const [key, a] of agg.byEmployee) {
    if (a.store !== store) continue;
    const p = get(key.slice(0, key.lastIndexOf("|")), a.name);
    p.turnover += a.revenue;
    p.today += a.revenue;
    p.week += a.revenue;
    p.receipts += a.receipts;
    p.items += a.items;
  }

  // личные планы месяца
  const { data: planRows, error: planErr } = await supabaseAdmin.from("sales_plan_monthly").select("employee_ms_id, employee_name, sales_plan").eq("store", store).eq("plan_month", monthStart);
  if (planErr) throw planErr;
  const plans = new Map<string, number | null>();
  for (const r of (planRows ?? []) as { employee_ms_id: string; employee_name: string; sales_plan: number | null }[]) {
    if (HIDDEN.has(r.employee_ms_id)) continue;
    plans.set(r.employee_ms_id, r.sales_plan === null ? null : Number(r.sales_plan));
    if (!people.has(r.employee_ms_id)) get(r.employee_ms_id, r.employee_name);
  }

  const forecastOf = (turnover: number) => (turnover * daysInMonth) / day;
  const rows: SellerRow[] = [];
  const noSales: string[] = [];
  for (const [id, p] of people) {
    const plan = plans.get(id) ?? null;
    if (p.turnover <= 0 && p.receipts <= 0) {
      noSales.push(p.name);
      continue;
    }
    const fulfillment = plan && plan > 0 ? (p.turnover / plan) * 100 : null;
    const rate = fulfillment === null ? null : bonusRate(fulfillment);
    rows.push({
      id,
      name: p.name,
      turnover: p.turnover,
      plan,
      fulfillment,
      rate,
      bonus: rate === null ? null : (p.turnover * rate) / 100,
      forecastPct: plan && plan > 0 ? (forecastOf(p.turnover) / plan) * 100 : null,
      today: p.today,
      week: p.week,
      receipts: p.receipts,
      depth: p.receipts > 0 ? p.items / p.receipts : null,
    });
  }
  rows.sort((a, b) => b.turnover - a.turnover || a.name.localeCompare(b.name, "ru"));
  noSales.sort((a, b) => a.localeCompare(b, "ru"));

  // план команды — сумма личных планов всех продавцов города (и тех, у кого продаж пока нет)
  const teamPlan = [...plans.values()].reduce<number>((a, v) => a + (v ?? 0), 0);
  const turnover = rows.reduce((a, r) => a + r.turnover, 0);
  const receipts = rows.reduce((a, r) => a + r.receipts, 0);
  const items = [...people.values()].filter((p) => p.turnover > 0 || p.receipts > 0).reduce((a, p) => a + p.items, 0);
  return {
    store,
    date: today,
    day,
    daysInMonth,
    team: {
      turnover,
      plan: teamPlan,
      fulfillment: teamPlan > 0 ? (turnover / teamPlan) * 100 : null,
      forecast: forecastOf(turnover),
      forecastPct: teamPlan > 0 ? (forecastOf(turnover) / teamPlan) * 100 : null,
      today: rows.reduce((a, r) => a + r.today, 0),
      week: rows.reduce((a, r) => a + r.week, 0),
      receipts,
      avgCheck: receipts > 0 ? turnover / receipts : null,
      depth: receipts > 0 ? items / receipts : null,
    },
    rows,
    noSales,
    updatedAt: new Date().toISOString(),
  };
}
