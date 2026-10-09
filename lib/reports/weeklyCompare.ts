// Сравнение двух недель по дням (оборот, посетители, чеки, товары, средний чек, выполнение плана,
// конверсия, глубина чека) и PDF в виде таблицы, как у владельца в Google-таблице. Каждый понедельник в 9:00
// бот-помощник присылает его администратору города (Картбаев Нуржан).
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { addDays, mondayOf } from "@/lib/coach/metrics";

export type CompareDay = {
  date: string;
  planRevenue: number;
  planTraffic: number;
  revenue: number;
  visitors: number;
  receipts: number;
  items: number;
};
export type CompareWeek = { from: string; to: string; days: CompareDay[] };

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function weekdayOf(date: string) {
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

type PeriodRow = { plan_month: string; p1_from: string | null; p1_to: string | null; p1_percent: number | null; p2_from: string | null; p2_to: string | null; p2_percent: number | null };

// Дневной план оборота города — как в окне «План продаж»: план месяца (сумма планов сотрудников) × процент
// периода месяца, в который попадает день, ÷ число дней периода; без периодов — план месяца ÷ дни месяца;
// день вне заданных периодов — 0.
function dayRevenuePlan(date: string, monthPlans: Map<string, number>, periods: Map<string, PeriodRow>): number {
  const monthKey = `${date.slice(0, 7)}-01`;
  const monthPlan = monthPlans.get(monthKey) ?? 0;
  if (monthPlan <= 0) return 0;
  const [y, m] = date.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const row = periods.get(monthKey);
  if (!row) return monthPlan / daysInMonth;
  const cur = [
    { from: row.p1_from, to: row.p1_to, percent: row.p1_percent },
    { from: row.p2_from, to: row.p2_to, percent: row.p2_percent },
  ].find((c) => c.from && c.to && c.from <= date && date <= c.to);
  if (!cur || !cur.from || !cur.to) return 0;
  return (monthPlan * (Number(cur.percent) || 0)) / 100 / (daysBetween(cur.from, cur.to) + 1);
}

// Две подряд идущие недели (пн–вс). weekFrom — понедельник первой недели; по умолчанию — две последние
// полностью прошедшие недели.
export async function loadWeeklyCompare(store: string, today: string, weekFrom?: string): Promise<{ weeks: [CompareWeek, CompareWeek]; city: string }> {
  const lastMonday = mondayOf(today);
  const w1 = weekFrom ?? addDays(lastMonday, -14);
  const w2 = addDays(w1, 7);
  const from = w1;
  const to = addDays(w2, 6);

  const regRes = await supabaseAdmin.from("moysklad_registers").select("id").eq("store", store);
  if (regRes.error) throw regRes.error;
  const registerIds = (regRes.data ?? []).map((r) => r.id as string);

  const [salesRes, trafficRes, plansRes, periodsRes] = await Promise.all([
    registerIds.length
      ? supabaseAdmin.from("moysklad_sales_daily").select("sale_date, revenue, receipts_count, items_count").in("register_id", registerIds).gte("sale_date", from).lte("sale_date", to)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("traffic_entries").select("entry_date, traffic_fact, traffic_plan").eq("store", store).gte("entry_date", from).lte("entry_date", to),
    supabaseAdmin.from("sales_plan_monthly").select("plan_month, sales_plan").eq("store", store).gte("plan_month", `${from.slice(0, 7)}-01`).lte("plan_month", to),
    supabaseAdmin.from("sales_plan_periods").select("*").eq("store", store).gte("plan_month", `${from.slice(0, 7)}-01`).lte("plan_month", to),
  ]);
  if (salesRes.error) throw salesRes.error;
  if (trafficRes.error) throw trafficRes.error;
  if (plansRes.error) throw plansRes.error;
  if (periodsRes.error) throw periodsRes.error;

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
  const periods = new Map<string, PeriodRow>();
  for (const r of (periodsRes.data ?? []) as PeriodRow[]) periods.set(r.plan_month, r);

  const build = (start: string): CompareWeek => ({
    from: start,
    to: addDays(start, 6),
    days: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      const s = sales.get(date);
      const t = traffic.get(date);
      return {
        date,
        planRevenue: dayRevenuePlan(date, monthPlans, periods),
        planTraffic: t?.plan ?? 0,
        revenue: s?.revenue ?? 0,
        visitors: t?.fact ?? 0,
        receipts: s?.receipts ?? 0,
        items: s?.items ?? 0,
      };
    }),
  });
  return { weeks: [build(w1), build(w2)], city: CITY[store] ?? store };
}

// ───────── расчёты и оформление ─────────

type Totals = Omit<CompareDay, "date">;
const sumDays = (days: CompareDay[]): Totals =>
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
const int = (n: number) => nf0.format(Math.round(n)).replace(/[  ]/g, " ");
const dec = (n: number, d: number) => n.toFixed(d).replace(".", ",");
const pct = (n: number, d = 2) => `${dec(n, d)}%`;
const signed = (n: number, f: (x: number) => string) => (n > 0 ? `+${f(n)}` : f(n));

const ratios = (t: Totals) => ({
  atv: t.receipts > 0 ? t.revenue / t.receipts : 0,
  revPct: t.planRevenue > 0 ? (t.revenue / t.planRevenue) * 100 : null,
  trafPct: t.planTraffic > 0 ? (t.visitors / t.planTraffic) * 100 : null,
  cr: t.visitors > 0 ? (t.receipts / t.visitors) * 100 : 0,
  depth: t.receipts > 0 ? t.items / t.receipts : 0,
});

function dayCells(label: string, wd: string, t: Totals): string[] {
  const r = ratios(t);
  return [
    label,
    wd,
    t.planRevenue > 0 ? int(t.planRevenue) : "—",
    t.planTraffic > 0 ? int(t.planTraffic) : "—",
    int(t.revenue),
    int(t.visitors),
    int(t.receipts),
    int(t.items),
    int(r.atv),
    r.revPct === null ? "—" : pct(r.revPct),
    r.trafPct === null ? "—" : pct(r.trafPct),
    pct(r.cr, 1),
    dec(r.depth, 2),
  ];
}

type Fonts = { regular: string; bold: string };
async function loadFonts(): Promise<Fonts> {
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

type RGB = [number, number, number];
const COLOR = {
  head: [162, 196, 201] as RGB,
  band: [217, 234, 211] as RGB,
  plan: [255, 255, 255] as RGB,
  fact: [217, 210, 233] as RGB,
  blue: [159, 197, 248] as RGB,
  total: [194, 123, 160] as RGB,
  note: [255, 255, 255] as RGB,
};

// PDF в альбомной ориентации: две недели по дням, итоги недель и разница второй недели от первой.
export async function buildWeeklyComparePdf(weeks: [CompareWeek, CompareWeek], city: string): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  pdf.addFileToVFS("NotoSans-Regular.ttf", fonts.regular);
  pdf.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  pdf.addFileToVFS("NotoSans-Bold.ttf", fonts.bold);
  pdf.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");

  const fmtDay = (d: string) => String(Number(d.slice(8, 10)));
  const period = (w: CompareWeek) => `${w.from.slice(8, 10)}.${w.from.slice(5, 7)}–${w.to.slice(8, 10)}.${w.to.slice(5, 7)}`;

  pdf.setFont("NotoSans", "bold");
  pdf.setFontSize(13);
  pdf.text(`Сравнение недель · ${city}`, 148.5, 9, { align: "center" });
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(8.5);
  pdf.text(`1 неделя: ${period(weeks[0])}   ·   2 неделя: ${period(weeks[1])}`, 148.5, 13.5, { align: "center" });

  const head = [
    "Число",
    "День недели",
    "ОБОРОТ\nПлан на день",
    "ПОСЕТИТЕЛЬ\nПлан на день",
    "ОБОРОТ\nФакт на день",
    "Посетители",
    "Кол-во чеков",
    "Кол-во товаров",
    "ATV\n(средний чек)",
    "ОБОРОТ %\nвыполнения\nдневного плана",
    "ПОСЕТИТЕЛЬ %\nвыполнения\nплана",
    "CR\n(конверсия)",
    "Глубина чека",
  ];

  type Row = { cells: string[]; kind: "head" | "band" | "day" | "total" | "diff" | "gap" };
  const rows: Row[] = [];
  const totals = weeks.map((w) => sumDays(w.days));
  weeks.forEach((w, i) => {
    rows.push({ cells: [`${i + 1} Неделя`], kind: "band" });
    for (const d of w.days) rows.push({ cells: dayCells(fmtDay(d.date), weekdayOf(d.date), sumDays([d])), kind: "day" });
    const t = totals[i];
    rows.push({ cells: dayCells("итог", "", t), kind: "total" });
  });
  rows.push({ cells: [""], kind: "gap" });

  const [t1, t2] = totals;
  const r1 = ratios(t1);
  const r2 = ratios(t2);
  const rel = (a: number, b: number) => (a > 0 ? pct(((b - a) / a) * 100) : "—");
  const diffPP = (a: number | null, b: number | null) => (a === null || b === null ? "—" : signed(b - a, (x) => pct(x)));
  type Cell = string | { content: string; colSpan?: number; rowSpan?: number };
  const diffRows: Cell[][] = [
    [
      { content: "разница недели 2 от 1", colSpan: 3, rowSpan: 2 },
      "цифра",
      signed(t2.revenue - t1.revenue, int),
      signed(t2.visitors - t1.visitors, int),
      signed(t2.receipts - t1.receipts, int),
      signed(t2.items - t1.items, int),
      signed(r2.atv - r1.atv, int),
      { content: diffPP(r1.revPct, r2.revPct), rowSpan: 2 },
      { content: diffPP(r1.trafPct, r2.trafPct), rowSpan: 2 },
      { content: signed(r2.cr - r1.cr, (x) => pct(x)), rowSpan: 2 },
      signed(r2.depth - r1.depth, (x) => dec(x, 2)),
    ],
    ["%", rel(t1.revenue, t2.revenue), rel(t1.visitors, t2.visitors), rel(t1.receipts, t2.receipts), rel(t1.items, t2.items), rel(r1.atv, r2.atv), rel(r1.depth, r2.depth)],
  ];

  autoTable(pdf, {
    startY: 17,
    head: [head],
    body: [...rows.map((r) => r.cells as Cell[]), ...diffRows],
    margin: { left: 6, right: 6, top: 6, bottom: 6 },
    theme: "grid",
    styles: { font: "NotoSans", fontSize: 8, cellPadding: 1.3, halign: "center", valign: "middle", lineColor: [0, 0, 0], lineWidth: 0.2, textColor: [20, 20, 20], minCellHeight: 6.6 },
    headStyles: { fillColor: COLOR.head, textColor: [20, 20, 20], fontStyle: "bold", fontSize: 7.5, lineColor: [0, 0, 0], lineWidth: 0.2 },
    tableWidth: 285,
    columnStyles: { 0: { cellWidth: 15 }, 1: { cellWidth: 17 }, 2: { cellWidth: 23 }, 3: { cellWidth: 23 }, 4: { cellWidth: 23 }, 5: { cellWidth: 23 }, 6: { cellWidth: 23 }, 7: { cellWidth: 23 }, 8: { cellWidth: 23 }, 9: { cellWidth: 23 }, 10: { cellWidth: 23 }, 11: { cellWidth: 23 }, 12: { cellWidth: 23 } },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const row: Row = rows[data.row.index] ?? { cells: [], kind: "diff" };
      const col = data.column.index;
      const cell = data.cell;
      if (row.kind === "band") {
        cell.styles.fillColor = COLOR.band;
        cell.styles.fontStyle = "bold";
        cell.styles.fontSize = 10;
        if (col === 0) cell.colSpan = 13;
        return;
      }
      if (row.kind === "gap") {
        cell.styles.fillColor = COLOR.band;
        cell.styles.minCellHeight = 4;
        if (col === 0) cell.colSpan = 13;
        return;
      }
      if (row.kind === "total") {
        cell.styles.fillColor = COLOR.total;
        cell.styles.fontStyle = "bold";
        if (col === 0) {
          cell.colSpan = 2;
          cell.styles.fontSize = 9.5;
        }
        return;
      }
      if (row.kind === "diff") {
        cell.styles.fillColor = COLOR.total;
        cell.styles.fontStyle = "bold";
        return;
      }
      // день недели: факт (оборот, посетители, чеки, товары) — сиреневым, ATV и проценты, CR, глубина — голубым
      if (col >= 4 && col <= 7) cell.styles.fillColor = COLOR.fact;
      else if (col >= 8) cell.styles.fillColor = COLOR.blue;
      if (col >= 8) cell.styles.fontStyle = "bold";
    },
  });

  // Подпись внизу: откуда план.
  const y = (pdf as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 190;
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(7);
  pdf.setTextColor(100);
  pdf.text("План оборота — дневной план города из раздела «Продажа» (план месяца по периодам), план посетителей — из «Статистики». Оборот с учётом возвратов. Конверсия = чеки ÷ посетители, глубина = товары ÷ чеки.", 6, Math.min(y + 4, 204));

  return new Uint8Array(pdf.output("arraybuffer"));
}
