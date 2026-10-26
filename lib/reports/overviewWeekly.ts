// PDF «Обзор» за неделю с разницей от предыдущей недели — как PDF страницы «Обзор» (показатели, продажи по дням, оборачиваемость
// по категориям), плюс таблица «Сравнение» и колонки разницы у оборачиваемости. Каждый понедельник уходит закупщику
// отдельным файлом по каждому городу (app/api/telegram/coach/overview-weekly).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { warehousesForCities } from "@/lib/warehouses";
import { addDays, mondayOf } from "@/lib/coach/metrics";
import { buildPdf, type PdfDoc, type PdfFonts, type PdfSection } from "@/lib/exportPdf";
import { ruDay, ruPeriod } from "@/lib/fileNames";

export const OVERVIEW_CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };

// Те же пять корневых папок и подписи, что на странице «Обзор».
const TOP_CATEGORIES: { key: string; label: string }[] = [
  { key: "Верхняя", label: "Верх" },
  { key: "Плечевая", label: "Плечевой" },
  { key: "Брюки", label: "Брюки" },
  { key: "Обувь", label: "Обувь" },
  { key: "Аксессуары", label: "Аксессуары" },
];

export type OverviewDay = { date: string; revenue: number; receipts: number; items: number; cost: number | null };
export type OverviewBucket = { label: string; cogs: number; stockValue: number; revenue: number; stockValueEnd: number };
export type OverviewWeek = { from: string; to: string; days: OverviewDay[]; trafficByDate: Record<string, number>; buckets: OverviewBucket[] };

// Две последние полные недели (пн–вс): та, что только что закончилась, и предыдущая.
export function lastTwoWeeks(today: string, mondayOfFirst?: string): [{ from: string; to: string }, { from: string; to: string }] {
  const firstMonday = mondayOfFirst ?? addDays(mondayOf(today), -14);
  return [
    { from: firstMonday, to: addDays(firstMonday, 6) },
    { from: addDays(firstMonday, 7), to: addDays(firstMonday, 13) },
  ];
}

// Данные недели по городу — те же таблицы и правила, что на странице «Обзор».
export async function loadOverviewWeek(store: string, from: string, to: string): Promise<OverviewWeek> {
  const reg = await supabaseAdmin.from("moysklad_registers").select("id").eq("store", store);
  if (reg.error) throw reg.error;
  const registerIds = (reg.data ?? []).map((r) => r.id as string);
  const [salesRes, trafficRes, turnoverRes] = await Promise.all([
    registerIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabaseAdmin
          .from("moysklad_sales_daily")
          .select("sale_date, revenue, receipts_count, items_count, cost")
          .in("register_id", registerIds)
          .gte("sale_date", from)
          .lte("sale_date", to)
          .limit(5000),
    supabaseAdmin.from("traffic_entries").select("entry_date, traffic_fact").eq("store", store).gte("entry_date", from).lte("entry_date", to),
    supabaseAdmin.rpc("stock_turnover_by_category", { p_stores: warehousesForCities([store]), p_from: from, p_to: to }),
  ]);
  if (salesRes.error) throw salesRes.error;
  if (trafficRes.error) throw trafficRes.error;
  if (turnoverRes.error) throw turnoverRes.error;

  const byDate = new Map<string, { revenue: number; receipts: number; items: number; costSum: number; costMissing: boolean }>();
  for (const r of (salesRes.data ?? []) as { sale_date: string; revenue: number; receipts_count: number; items_count: number; cost: number | null }[]) {
    const a = byDate.get(r.sale_date) ?? { revenue: 0, receipts: 0, items: 0, costSum: 0, costMissing: false };
    a.revenue += Number(r.revenue) || 0;
    a.receipts += Number(r.receipts_count) || 0;
    a.items += Number(r.items_count) || 0;
    if (r.cost === null) a.costMissing = true;
    else a.costSum += Number(r.cost);
    byDate.set(r.sale_date, a);
  }
  const days = [...byDate.entries()]
    .map(([date, a]) => ({ date, revenue: a.revenue, receipts: a.receipts, items: a.items, cost: a.costMissing ? null : a.costSum }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const trafficByDate: Record<string, number> = {};
  for (const r of (trafficRes.data ?? []) as { entry_date: string; traffic_fact: number | null }[]) {
    trafficByDate[r.entry_date] = (trafficByDate[r.entry_date] ?? 0) + (Number(r.traffic_fact) || 0);
  }

  type Row = { category: string; cogs: number; stock_value: number; revenue: number; stock_value_end: number };
  const byCategory = new Map(((turnoverRes.data ?? []) as Row[]).map((r) => [r.category, r]));
  const buckets = TOP_CATEGORIES.map((b) => {
    const r = byCategory.get(b.key);
    return { label: b.label, cogs: Number(r?.cogs ?? 0), stockValue: Number(r?.stock_value ?? 0), revenue: Number(r?.revenue ?? 0), stockValueEnd: Number(r?.stock_value_end ?? 0) };
  });
  return { from, to, days, trafficByDate, buckets };
}

type Totals = {
  revenue: number;
  receipts: number;
  items: number;
  cost: number | null;
  traffic: number;
  avgCheck: number | null;
  depth: number | null;
  conversion: number | null;
  margin: number | null;
  turnover: number | null;
  cogs: number;
  stockEnd: number;
  stockAvg: number;
};

function totalsOf(w: OverviewWeek): Totals {
  const revenue = w.days.reduce((a, r) => a + r.revenue, 0);
  const receipts = w.days.reduce((a, r) => a + r.receipts, 0);
  const items = w.days.reduce((a, r) => a + r.items, 0);
  const costKnown = w.days.every((r) => r.cost !== null);
  const cost = costKnown ? w.days.reduce((a, r) => a + (r.cost ?? 0), 0) : null;
  const traffic = Object.values(w.trafficByDate).reduce((a, n) => a + n, 0);
  const cogs = w.buckets.reduce((a, r) => a + r.cogs, 0);
  const stockAvg = w.buckets.reduce((a, r) => a + r.stockValue, 0);
  const stockEnd = w.buckets.reduce((a, r) => a + r.stockValueEnd, 0);
  return {
    revenue,
    receipts,
    items,
    cost,
    traffic,
    avgCheck: receipts > 0 ? revenue / receipts : null,
    depth: receipts > 0 ? items / receipts : null,
    conversion: traffic > 0 ? (receipts / traffic) * 100 : null,
    margin: cost !== null ? revenue - cost : null,
    turnover: stockAvg > 0 ? (cogs / stockAvg) * 100 : null,
    cogs,
    stockEnd,
    stockAvg,
  };
}

const sp = (s: string) => s.replace(/[  ]/g, " ");
const grouped = (n: number, digits: number) => sp(n.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const money = (n: number) => `${grouped(n, 0)} ₸`;
const money2 = (n: number) => `${grouped(n, 2)} ₸`;
const signed = (n: number, digits: number) => {
  const r = Number(n.toFixed(digits));
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${grouped(Math.abs(r), digits)}`;
};

type Kind = "money" | "int" | "dec" | "conv" | "pct";
const show = (n: number | null, kind: Kind): string =>
  n === null ? "—" : kind === "money" ? money(n) : kind === "int" ? grouped(Math.round(n), 0) : kind === "dec" ? grouped(n, 2) : kind === "conv" ? `${grouped(n, 2)}%` : `${grouped(n, 1)}%`;

// Разница: цифра (у процентов — в п.п.) и относительное изменение в %.
function diff(cur: number | null, prev: number | null, kind: Kind): [string, string] {
  if (cur === null || prev === null) return ["—", "—"];
  const abs = cur - prev;
  const absText = kind === "money" ? `${signed(abs, 0)} ₸` : kind === "int" ? signed(abs, 0) : kind === "dec" ? signed(abs, 2) : kind === "conv" ? `${signed(abs, 2)} п.п.` : `${signed(abs, 1)} п.п.`;
  return [absText, prev !== 0 ? `${signed(((cur - prev) / Math.abs(prev)) * 100, 1)}%` : "—"];
}

async function loadFonts(): Promise<PdfFonts> {
  const get = async (name: string) => {
    try {
      return (await readFile(path.join(process.cwd(), "public", "fonts", "pdf", name))).toString("base64");
    } catch {
      const res = await fetch(`https://www.overman.kz/fonts/pdf/${name}`);
      if (!res.ok) throw new Error(`Шрифт ${name} недоступен.`);
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    }
  };
  const [regular, bold, serif] = await Promise.all([get("NotoSans-Regular.ttf"), get("NotoSans-Bold.ttf"), get("NotoSerif-Bold.ttf")]);
  return { regular, bold, serif };
}

export function overviewFileName(store: string, week: { from: string; to: string }): string {
  return `Обзор ${OVERVIEW_CITY[store] ?? store} ${ruPeriod(week.from, week.to)}.pdf`;
}

export async function buildOverviewPdf(store: string, cur: OverviewWeek, prev: OverviewWeek): Promise<Uint8Array> {
  const city = OVERVIEW_CITY[store] ?? store;
  const c = totalsOf(cur);
  const p = totalsOf(prev);
  const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  const curLabel = `${dm(cur.from)}–${dm(cur.to)}`;
  const prevLabel = `${dm(prev.from)}–${dm(prev.to)}`;

  // «Сравнение»: показатель, позапрошлая неделя, прошлая, разница цифрой и в %.
  const metrics: { label: string; kind: Kind; cur: number | null; prev: number | null }[] = [
    { label: "Оборот", kind: "money", cur: c.revenue, prev: p.revenue },
    { label: "Чеков", kind: "int", cur: c.receipts, prev: p.receipts },
    { label: "Штук", kind: "int", cur: c.items, prev: p.items },
    { label: "Средний чек", kind: "money", cur: c.avgCheck, prev: p.avgCheck },
    { label: "Глубина чека", kind: "dec", cur: c.depth, prev: p.depth },
    { label: "Посетителей", kind: "int", cur: c.traffic > 0 ? c.traffic : null, prev: p.traffic > 0 ? p.traffic : null },
    { label: "Конверсия", kind: "conv", cur: c.conversion, prev: p.conversion },
    { label: "Себестоимость", kind: "money", cur: c.cost, prev: p.cost },
    { label: "Валовая прибыль", kind: "money", cur: c.margin, prev: p.margin },
    { label: "Оборачиваемость склада", kind: "pct", cur: c.turnover, prev: p.turnover },
  ];
  const compareRows = metrics.map((m) => [m.label, show(m.prev, m.kind), show(m.cur, m.kind), ...diff(m.cur, m.prev, m.kind)]);

  const dayRows: (string | number)[][] = cur.days.map((r) => {
    const visitors = cur.trafficByDate[r.date];
    return [
      ruDay(r.date),
      money(r.revenue),
      r.receipts,
      r.items,
      r.receipts > 0 ? money(r.revenue / r.receipts) : "—",
      visitors !== undefined ? Math.round(visitors) : "—",
      visitors > 0 ? `${grouped((r.receipts / visitors) * 100, 2)}%` : "—",
      r.cost !== null ? money(r.cost) : "—",
      r.cost !== null ? money(r.revenue - r.cost) : "—",
    ];
  });
  dayRows.push([
    "Итого",
    money(c.revenue),
    c.receipts,
    c.items,
    c.avgCheck !== null ? money(c.avgCheck) : "—",
    c.traffic > 0 ? Math.round(c.traffic) : "—",
    c.conversion !== null ? `${grouped(c.conversion, 2)}%` : "—",
    c.cost !== null ? money(c.cost) : "—",
    c.margin !== null ? money(c.margin) : "—",
  ]);

  const sections: PdfSection[] = [
    {
      title: `Сравнение с позапрошлой неделей (${prevLabel} → ${curLabel})`,
      note: "Разница — прошлая неделя минус позапрошлая; у процентов — в процентных пунктах и в %.",
      headers: ["Показатель", `Позапрошлая ${prevLabel}`, `Прошлая ${curLabel}`, "Разница", "Разница, %"],
      widths: [2.2, 1.6, 1.6, 1.4, 1.2],
      rows: compareRows,
    },
    {
      title: "Продажи по дням",
      headers: ["Дата", "Оборот", "Чеков", "Штук", "Средний чек", "Посетителей", "Конверсия", "Себестоимость", "Валовая прибыль"],
      widths: [1.2, 1.6, 1, 1, 1.4, 1.2, 1.1, 1.6, 1.6],
      rows: dayRows,
      rowKinds: dayRows.map((_, i) => (i === dayRows.length - 1 ? "total" : "normal")),
    },
  ];

  // Оборачиваемость по категориям: как на странице, плюс оборачиваемость позапрошлой недели и разница.
  const turnoverOf = (b: OverviewBucket) => (b.stockValue > 0 ? (b.cogs / b.stockValue) * 100 : null);
  const catRows: (string | number)[][] = cur.buckets.map((b, i) => {
    const now = turnoverOf(b);
    const before = turnoverOf(prev.buckets[i]);
    return [b.label, money2(b.cogs), money2(b.stockValueEnd), money2(b.stockValue), now !== null ? `${grouped(now, 0)}%` : "—", before !== null ? `${grouped(before, 0)}%` : "—", now !== null && before !== null ? `${signed(now - before, 0)} п.п.` : "—"];
  });
  catRows.push([
    "Итого",
    money2(c.cogs),
    money2(c.stockEnd),
    money2(c.stockAvg),
    c.turnover !== null ? `${grouped(c.turnover, 0)}%` : "—",
    p.turnover !== null ? `${grouped(p.turnover, 0)}%` : "—",
    c.turnover !== null && p.turnover !== null ? `${signed(c.turnover - p.turnover, 0)} п.п.` : "—",
  ]);
  sections.push({
    title: "Оборачиваемость по категориям",
    note: "Остаток — на конец недели, как в МойСклад. Оборачиваемость = себестоимость продаж за неделю / средний остаток за неделю.",
    headers: ["Категория", "Себестоимость продаж", "Остаток на конец недели", "Средний остаток за неделю", "Оборачиваемость", "Позапрошлая неделя", "Разница"],
    widths: [1.8, 1.6, 1.6, 1.6, 1.3, 1.3, 1.2],
    rows: catRows,
    rowKinds: catRows.map((_, i) => (i === catRows.length - 1 ? "total" : "normal")),
  });

  const note = (cv: number | null, pv: number | null, kind: Kind) => {
    if (cv === null || pv === null) return undefined;
    const [, rel] = diff(cv, pv, kind);
    return rel === "—" ? undefined : `${rel} к позапрошлой неделе`;
  };
  const doc: PdfDoc = {
    fileName: `Обзор ${city} ${ruPeriod(cur.from, cur.to)}`,
    title: `Обзор продаж · ${city}`,
    subtitle: `Прошлая неделя: ${ruDay(cur.from)} — ${ruDay(cur.to)} · позапрошлая: ${ruDay(prev.from)} — ${ruDay(prev.to)}`,
    kpis: [
      { label: "Оборот", value: money(c.revenue), note: note(c.revenue, p.revenue, "money") },
      { label: "Чеков", value: grouped(c.receipts, 0), note: note(c.receipts, p.receipts, "int") },
      { label: "Средний чек", value: c.avgCheck !== null ? money(c.avgCheck) : "—", note: note(c.avgCheck, p.avgCheck, "money") },
      { label: "Конверсия", value: c.conversion !== null ? `${grouped(c.conversion, 2)}%` : "—", note: c.traffic > 0 ? `${grouped(Math.round(c.traffic), 0)} посетителей` : undefined },
      { label: "Глубина чека", value: c.depth !== null ? `${grouped(c.depth, 1)} шт` : "—" },
      { label: "Валовая прибыль", value: c.margin !== null ? money(c.margin) : "—", note: note(c.margin, p.margin, "money") },
      { label: "Оборачиваемость склада", value: c.turnover !== null ? `${grouped(c.turnover, 1)}%` : "—" },
    ],
    sections,
  };
  return new Uint8Array(buildPdf(doc, await loadFonts()).output("arraybuffer"));
}
