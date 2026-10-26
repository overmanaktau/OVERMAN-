// PDF «Склад — обзор» за неделю с разницей от предыдущей недели: тот же отчёт, что на странице «Склад → Обзор» (категории, поставщики, склады:
// остаток, продано, себестоимость, валовая прибыль, валовый %, оборачиваемость) и блоки «сравнение периодов». Каждый понедельник уходит закупщику
// отдельным файлом по каждому городу (app/api/telegram/coach/warehouse-overview-weekly). Расчёт — как на странице с настройками по умолчанию:
// склады города, на которых есть товар, без заморозки, без категорий «Бесплатный» и «Без категории».
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WAREHOUSES, warehousesForCities } from "@/lib/warehouses";
import { addDays, mondayOf, monthStartOf } from "@/lib/coach/metrics";
import { buildPdf, type PdfDoc, type PdfFonts, type PdfSection } from "@/lib/exportPdf";
import { ruPeriod } from "@/lib/fileNames";
import { abcXyzSections, loadAbcXyz, type AbcData } from "@/lib/reports/abcXyz";

export const WAREHOUSE_CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };

const TOP_CATEGORIES: { key: string; label: string }[] = [
  { key: "Верхняя", label: "Верх" },
  { key: "Плечевая", label: "Плечевой" },
  { key: "Брюки", label: "Брюки" },
  { key: "Обувь", label: "Обувь" },
  { key: "Аксессуары", label: "Аксессуары" },
];
const EXCLUDED_CATEGORIES = ["Бесплатный", "Без категории"]; // выключены галочками на странице по умолчанию (названия на экране)

export type OverviewRow = {
  name: string;
  stockEnd: number; // остаток по факту на последний день периода (себестоимость)
  stockAvg: number; // средний остаток за период
  revenue: number;
  cogs: number;
};
export type OverviewSet = { cat: OverviewRow[]; sup: OverviewRow[]; sto: OverviewRow[] };
export type WarehouseWeek = { from: string; to: string; stores: string[]; data: OverviewSet; abc?: AbcData }; // abc — только у недели, по которой считается АВС/XYZ

// Две последние полные недели (пн–вс): более ранняя (позапрошлая) и та, что только что закончилась (прошлая).
export function lastTwoWeeks(today: string, mondayOfFirst?: string): [{ from: string; to: string }, { from: string; to: string }] {
  const firstMonday = mondayOfFirst ?? addDays(mondayOf(today), -14);
  return [
    { from: firstMonday, to: addDays(firstMonday, 6) },
    { from: addDays(firstMonday, 7), to: addDays(firstMonday, 13) },
  ];
}

// Два последних полных месяца: позапрошлый (первым) и только что закончившийся прошлый.
export function lastTwoMonths(today: string): [{ from: string; to: string }, { from: string; to: string }] {
  const curTo = addDays(monthStartOf(today), -1);
  const curFrom = monthStartOf(curTo);
  const prevTo = addDays(curFrom, -1);
  return [
    { from: monthStartOf(prevTo), to: prevTo },
    { from: curFrom, to: curTo },
  ];
}

export type OverviewKind = "week" | "month";
const WORDS: Record<OverviewKind, { cur: string; prev: string; prevDat: string; curAdj: string; noun: string }> = {
  week: { cur: "Прошлая неделя", prev: "позапрошлая неделя", prevDat: "позапрошлой неделе", curAdj: "прошлая", noun: "неделя" },
  month: { cur: "Прошлый месяц", prev: "позапрошлый месяц", prevDat: "позапрошлому месяцу", curAdj: "прошлый", noun: "месяц" },
};

// Склады города, на которых сейчас есть товар (как фильтр на странице).
export async function stockedWarehousesOf(city: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.rpc("stock_warehouses");
  if (error) throw error;
  const stocked = new Set(((data ?? []) as { store: string }[]).map((r) => r.store));
  return warehousesForCities([city]).filter((c) => stocked.has(c));
}

async function fetchAllRows<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await build(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

export async function loadOverviewSet(stores: string[], from: string, to: string): Promise<OverviewSet> {
  const exclude = EXCLUDED_CATEGORIES.map((label) => TOP_CATEGORIES.find((c) => c.label === label)?.key ?? label);
  const args = { p_stores: stores, p_from: from, p_to: to };
  const argsEx = { ...args, p_exclude: exclude };
  type Cat = { category: string; cogs: number; stock_value: number; revenue: number; stock_value_end: number };
  type Sup = { supplier_name: string; revenue: number; cogs: number; stock_value: number; stock_value_end: number };
  type Sto = { store: string; revenue: number; cogs: number; stock_value: number; stock_value_end: number };
  const label = (key: string) => TOP_CATEGORIES.find((c) => c.key === key)?.label ?? key;
  const order = (key: string) => {
    const i = TOP_CATEGORIES.findIndex((c) => c.key === key);
    return i === -1 ? 99 : i;
  };
  const mk = (name: string, r: { stock_value_end: number; stock_value: number; revenue: number; cogs: number }): OverviewRow => ({
    name,
    stockEnd: Number(r.stock_value_end),
    stockAvg: Number(r.stock_value),
    revenue: Number(r.revenue),
    cogs: Number(r.cogs),
  });
  const [cat, sup, sto] = await Promise.all([
    fetchAllRows<Cat>((a, b) => supabaseAdmin.rpc("stock_turnover_by_category", args).range(a, b)),
    fetchAllRows<Sup>((a, b) => supabaseAdmin.rpc("warehouse_overview_by_supplier", argsEx).range(a, b)),
    fetchAllRows<Sto>((a, b) => supabaseAdmin.rpc("warehouse_overview_by_store", argsEx).range(a, b)),
  ]);
  return {
    cat: [...cat]
      .sort((x, y) => order(x.category) - order(y.category))
      .map((r) => mk(label(r.category), r))
      .filter((r) => !EXCLUDED_CATEGORIES.includes(r.name)),
    sup: sup.map((r) => mk(r.supplier_name, r)),
    sto: sto
      .filter((r) => Number(r.stock_value_end) !== 0 || Number(r.stock_value) !== 0 || Number(r.revenue) !== 0 || Number(r.cogs) !== 0)
      .map((r) => mk(WAREHOUSES.find((w) => w.code === r.store)?.label ?? (r.store === "frozen" ? "Заморозка" : r.store), r)),
  };
}

export async function loadWarehouseWeek(city: string, from: string, to: string, withAbc = false): Promise<WarehouseWeek> {
  const stores = await stockedWarehousesOf(city);
  const [data, abc] = await Promise.all([stores.length > 0 ? loadOverviewSet(stores, from, to) : Promise.resolve({ cat: [], sup: [], sto: [] }), withAbc ? loadAbcXyz(city, from, to) : Promise.resolve(undefined)]);
  return { from, to, stores, data, abc };
}

type Metrics = { profit: number; margin: number | null; turnover: number | null };
const metrics = (r: { revenue: number; cogs: number; stockAvg: number }): Metrics => {
  const profit = r.revenue - r.cogs;
  return { profit, margin: r.revenue > 0 ? (profit / r.revenue) * 100 : null, turnover: r.stockAvg > 0 ? (r.cogs / r.stockAvg) * 100 : null };
};
const total = (rows: OverviewRow[]): OverviewRow =>
  rows.reduce((a, r) => ({ name: "Итого", stockEnd: a.stockEnd + r.stockEnd, stockAvg: a.stockAvg + r.stockAvg, revenue: a.revenue + r.revenue, cogs: a.cogs + r.cogs }), { name: "Итого", stockEnd: 0, stockAvg: 0, revenue: 0, cogs: 0 });

const sp = (s: string) => s.replace(/[  ]/g, " ");
const plain2 = (n: number) => sp(n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money = (n: number) => `${plain2(n)} ₸`;
const pctText = (v: number | null, digits = 1) => (v === null ? "—" : `${sp(v.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }))}%`);
const lowMargin = (v: number | null) => v !== null && Math.round(v * 10) / 10 < 50; // валовый % ниже 50 — лёгкое красное выделение
const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
const deltaPct = (cur: number | null, prev: number | null | undefined): number | null => (cur === null || prev === null || prev === undefined || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);
const deltaText = (v: number | null): string => (v === null ? "—" : `${sign(v)}${sp(Math.abs(v).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 }))}%`);
const fmtRuDate = (iso: string) => iso.split("-").reverse().join(".");

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

export function warehouseFileName(city: string, week: { from: string; to: string }): string {
  return `Склад обзор ${city} ${ruPeriod(week.from, week.to)}.pdf`;
}

export async function buildWarehouseOverviewPdf(storeCode: string, prev: WarehouseWeek, cur: WarehouseWeek, kind: OverviewKind = "week"): Promise<Uint8Array> {
  const w = WORDS[kind];
  const city = WAREHOUSE_CITY[storeCode] ?? storeCode;
  const storeLabels = cur.stores.filter((c) => c !== "saya_park").map((c) => WAREHOUSES.find((w) => w.code === c)?.label ?? c);
  const rangeLabel = (w: { from: string; to: string }) => `${fmtRuDate(w.from)} — ${fmtRuDate(w.to)}`;

  const blocks: { title: string; nameHeader: string; rows: OverviewRow[]; prevRows: OverviewRow[] }[] = [
    { title: "По категориям", nameHeader: "Категория", rows: cur.data.cat, prevRows: prev.data.cat },
    { title: "По поставщикам", nameHeader: "Поставщик", rows: cur.data.sup, prevRows: prev.data.sup },
    ...(storeLabels.length > 1 ? [{ title: "По складам", nameHeader: "Склад", rows: cur.data.sto, prevRows: prev.data.sto }] : []),
  ];
  const sum = total(cur.data.cat.length > 0 ? cur.data.cat : cur.data.sto);
  const sumM = metrics(sum);
  const prevSum = total(prev.data.cat.length > 0 ? prev.data.cat : prev.data.sto);
  const prevSumM = metrics(prevSum);

  const metricCells = (r: OverviewRow): string[] => {
    const m = metrics(r);
    return [money(r.stockEnd), money(r.revenue), money(r.cogs), money(m.profit), pctText(m.margin), pctText(m.turnover)];
  };
  const tableRow = (r: OverviewRow): (string | number)[] => [r.name, ...metricCells(r)];

  // «Сравнение периодов»: у каждого показателя три колонки — предыдущая неделя, выбранная и разница (цифра и % двумя строками).
  const dateLabel = (from: string, to: string) => {
    const short = (iso: string) => fmtRuDate(iso).replace(/\.20(\d\d)$/, ".$1");
    return `${short(from)} –\n${short(to)}`;
  };
  const subs = [dateLabel(prev.from, prev.to), dateLabel(cur.from, cur.to), "Разница"];
  const groups = ["Остаток, ₸", "Продано, ₸", "Валовая прибыль, ₸", "Оборачиваемость, %"];
  const vals = (r: OverviewRow): (number | null)[] => [r.stockEnd, r.revenue, r.revenue - r.cogs, metrics(r).turnover];
  const cells = (r: OverviewRow, pr: OverviewRow | null | undefined): string[] => {
    const now = vals(r);
    const old = pr ? vals(pr) : null;
    const out: string[] = [];
    now.forEach((c, i) => {
      const isPct = i === 3;
      const fmt = (n: number | null) => (n === null ? "—" : isPct ? pctText(n) : plain2(n));
      const o = old ? old[i] : null;
      let diff = "—";
      if (c !== null && o !== null) {
        const abs = c - o;
        const rounded = isPct ? Math.round(abs * 10) / 10 : Math.round(abs * 100) / 100; // знак — по округлённому значению
        const absText = isPct ? `${sign(rounded)}${sp(Math.abs(rounded).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 }))} п.п.` : `${sign(rounded)}${plain2(Math.abs(rounded))}`;
        diff = `${absText}\n${deltaText(deltaPct(c, o))}`;
      }
      out.push(fmt(o), fmt(c), diff);
    });
    return out;
  };

  const mainSections: PdfSection[] = blocks.map((b) => {
    const sorted = [...b.rows].sort((x, y) => y.stockEnd - x.stockEnd);
    const body = [...sorted.map((r) => tableRow(r)), tableRow(total(b.rows))];
    return {
      title: b.title,
      headers: [b.nameHeader, "Остаток", "Продано", "Себестоимость", "Валовая прибыль", "Валовый %", "Оборачиваемость"],
      rows: body,
      rowKinds: body.map((_, i) => (i === body.length - 1 ? ("total" as const) : ("normal" as const))),
      softRed: [...sorted, total(b.rows)].map((r) => [false, false, false, false, false, lowMargin(metrics(r).margin), false]),
      widths: [2.4, 1.6, 1.6, 1.6, 1.6, 0.9, 1.3],
    };
  });

  const compareSections: PdfSection[] = blocks.map((b) => {
    const pm = new Map(b.prevRows.map((r) => [r.name, r]));
    const sorted = [...b.rows].sort((x, y) => y.stockEnd - x.stockEnd);
    const names = new Set(b.rows.map((r) => r.name));
    // у блока категорий в итог прошлого периода входят те же категории
    const prevTotal = total(b.nameHeader === "Категория" ? b.prevRows.filter((r) => names.has(r.name)) : b.prevRows);
    const rows: (string | number)[][] = sorted.map((r) => [r.name, ...cells(r, pm.get(r.name))]);
    rows.push(["Итого", ...cells(total(b.rows), prevTotal)]);
    return {
      title: `${b.title} — сравнение периодов`,
      note: `Слева — ${w.prev} (${rangeLabel(prev)}), справа — ${w.curAdj} (${rangeLabel(cur)}). Разница — ${w.curAdj} минус ${w.prev}; у оборачиваемости — в процентных пунктах и в %.`,
      headers: [b.nameHeader, ...groups.flatMap((g) => subs.map((s) => `${g.split(",")[0]} · ${s.replace("\n", " ")}`))],
      headGroups: [{ label: b.nameHeader, span: 1 }, ...groups.map((g) => ({ label: g, span: 3, subs }))],
      rows,
      rowKinds: rows.map((_, i) => (i === rows.length - 1 ? ("total" as const) : ("normal" as const))),
      widths: [2.1, 1.45, 1.45, 1.5, 1.45, 1.45, 1.5, 1.45, 1.45, 1.5, 0.9, 0.9, 1.25],
      fontSize: 7.2,
      grid: true,
      align: ["left", ...Array.from({ length: 12 }, () => "center" as const)],
      signColors: true,
    };
  });

  const kpiNote = (c: number | null, p: number | null) => {
    const d = deltaPct(c, p);
    return d === null ? undefined : `${deltaText(d)} к ${w.prevDat}`;
  };
  const doc: PdfDoc = {
    fileName: `Склад обзор ${city} ${ruPeriod(cur.from, cur.to)}`,
    orientation: "landscape",
    title: `Склад — обзор · ${city}`,
    subtitle: `${w.cur} (${rangeLabel(cur)}) · склады: ${storeLabels.join(", ")}`,
    meta: [
      "Остаток — по факту на последний день периода, как в МойСклад",
      "Оборачиваемость — себестоимость продаж ÷ средний остаток за период",
      "Валовая прибыль — продано минус себестоимость продаж",
    ],
    kpis: [
      { label: "Остаток", value: money(sum.stockEnd), note: kpiNote(sum.stockEnd, prevSum.stockEnd) },
      { label: "Продано", value: money(sum.revenue), note: kpiNote(sum.revenue, prevSum.revenue) },
      { label: "Валовая прибыль", value: money(sumM.profit), note: kpiNote(sumM.profit, prevSumM.profit) },
      { label: "Оборачиваемость", value: pctText(sumM.turnover), note: kpiNote(sumM.turnover, prevSumM.turnover) },
    ],
    sections: [...mainSections, ...compareSections, ...(cur.abc ? abcXyzSections(cur.abc) : [])],
  };
  return new Uint8Array(buildPdf(doc, await loadFonts()).output("arraybuffer"));
}
