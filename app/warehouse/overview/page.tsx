"use client";

import { trim2Ru } from "@/lib/numFormat";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { downloadExcel } from "@/lib/exportExcel";
import { WAREHOUSES, FILTER_WAREHOUSES, warehousesForCities } from "@/lib/warehouses";
import { useStockedWarehouses } from "@/lib/useStockedWarehouses";
import PdfButton from "@/components/PdfButton";
import SortHead, { type SortState } from "@/components/SortHead";
import type { PdfDoc, PdfSection } from "@/lib/downloadPdf";
import { ruPeriod } from "@/lib/fileNames";

// Склад → «Обзор»: за выбранный период и склады — остаток (по факту на последний день периода, как в МойСклад),
// сколько продано, себестоимость, валовая прибыль и оборачиваемость (себестоимость продаж ÷ средний остаток) —
// в разрезе категорий, поставщиков и складов. Периоды и границы — те же, что в «Обзоре» и «По поставщикам».

const PERIODS = ["Вчера", "Прошлая неделя", "Эта неделя", "С начала месяца", "Прошлый месяц", "Всё время"] as const;
type Period = number | "custom";
const DEFAULT_PERIOD = 0; // «Вчера»

const TOP_CATEGORIES: { key: string; label: string }[] = [
  { key: "Верхняя", label: "Верх" },
  { key: "Плечевая", label: "Плечевой" },
  { key: "Брюки", label: "Брюки" },
  { key: "Обувь", label: "Обувь" },
  { key: "Аксессуары", label: "Аксессуары" },
];

function money(n: number) {
  return `${trim2Ru(n)} ₸`;
}
function pctText(v: number | null) {
  return v === null ? "—" : `${trim2Ru(v)}%`;
}
// Валовый % ниже 50 — лёгкое красное выделение (на экране и в PDF)
const lowMargin = (v: number | null) => v !== null && Math.round(v * 100) / 100 < 50; // по показанному значению: 49,96 выводится как 50,0% и не красится
const LOW_MARGIN_CLS = "rounded px-1.5 py-0.5 bg-[#F6DAD2] text-[#A34B36]";
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtRuDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function rangeOf(period: Period, custom: { from: string; to: string }): { from: string; to: string; label: string } {
  if (period === "custom") return { from: custom.from, to: custom.to, label: `${fmtRuDate(custom.from)} — ${fmtRuDate(custom.to)}` };
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const add = (x: Date, n: number) => new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);
  const dow = d.getDay();
  const thisMonday = add(d, dow === 0 ? -6 : 1 - dow);
  const thisSunday = add(thisMonday, 6);
  let start = d;
  let end = d;
  if (period === 0) {
    start = add(d, -1);
    end = add(d, -1);
  } else if (period === 1) {
    start = add(thisMonday, -7);
    end = add(thisSunday, -7);
  } else if (period === 2) {
    start = thisMonday;
    end = thisSunday;
  } else if (period === 3) {
    start = new Date(d.getFullYear(), d.getMonth(), 1);
    end = d;
  } else if (period === 4) {
    start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    end = new Date(d.getFullYear(), d.getMonth(), 0);
  } else {
    start = new Date(2000, 0, 1);
    end = d;
  }
  const label = PERIODS[period].toLowerCase();
  return { from: ymd(start), to: ymd(end), label: period === 0 ? `${label} (${fmtRuDate(ymd(start))})` : `${label} (${fmtRuDate(ymd(start))} — ${fmtRuDate(ymd(end))})` };
}

// Сравнение: предыдущий период такой же длины. «Эта неделя» и «С начала месяца» сравниваются с тем же отрезком прошлой недели / прошлого месяца
// (по сегодняшний день недели / число), «Всё время» не сравнивается.
function prevRangeOf(period: Period, cur: { from: string; to: string }): { from: string; to: string; label: string } | null {
  if (period === 5) return null;
  const parse = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const add = (x: Date, n: number) => new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);
  const from = parse(cur.from);
  const to = parse(cur.to);
  const today = new Date();
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let start: Date;
  let end: Date;
  if (period === 2) {
    start = add(from, -7);
    end = add(d0, -7);
  } else if (period === 3) {
    start = new Date(from.getFullYear(), from.getMonth() - 1, 1);
    const lastDay = new Date(from.getFullYear(), from.getMonth(), 0).getDate();
    end = new Date(start.getFullYear(), start.getMonth(), Math.min(to.getDate(), lastDay));
  } else if (period === 4) {
    start = new Date(from.getFullYear(), from.getMonth() - 1, 1);
    end = new Date(from.getFullYear(), from.getMonth(), 0);
  } else {
    const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    end = add(from, -1);
    start = add(end, -(days - 1));
  }
  const a = ymd(start);
  const b = ymd(end);
  return { from: a, to: b, label: a === b ? fmtRuDate(a) : `${fmtRuDate(a)} — ${fmtRuDate(b)}` };
}

// Разница к предыдущему периоду, %: (сейчас − тогда) ÷ |тогда|. Если тогда было 0 — не посчитать.
function deltaPct(cur: number | null, prev: number | null | undefined): number | null {
  if (cur === null || prev === null || prev === undefined || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
function deltaText(v: number | null): string {
  if (v === null) return "—";
  const t = trim2Ru(Math.abs(v));
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${t}%`;
}
function Delta({ v }: { v: number | null }) {
  return <div className={`text-[11px] ${v === null || Math.abs(v) < 0.05 ? "text-mutedLight" : v > 0 ? "text-accent" : "text-[#A34B36]"}`}>{deltaText(v)}</div>;
}

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const pageSize = 1000;
  let offset = 0;
  const all: T[] = [];
  for (;;) {
    const { data, error } = await build(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

type Row = {
  name: string;
  stockEnd: number; // остаток по факту на последний день периода (себестоимость)
  stockAvg: number; // средний остаток за период
  revenue: number;
  cogs: number;
};
type Metrics = { profit: number; margin: number | null; turnover: number | null };

function metrics(r: { revenue: number; cogs: number; stockAvg: number }): Metrics {
  const profit = r.revenue - r.cogs;
  return {
    profit,
    margin: r.revenue > 0 ? (profit / r.revenue) * 100 : null,
    turnover: r.stockAvg > 0 ? (r.cogs / r.stockAvg) * 100 : null,
  };
}
function total(rows: Row[]): Row {
  return rows.reduce(
    (a, r) => ({ name: "Итого", stockEnd: a.stockEnd + r.stockEnd, stockAvg: a.stockAvg + r.stockAvg, revenue: a.revenue + r.revenue, cogs: a.cogs + r.cogs }),
    { name: "Итого", stockEnd: 0, stockAvg: 0, revenue: 0, cogs: 0 }
  );
}

type SortKey = "name" | "stockEnd" | "share" | "stockAvg" | "revenue" | "cogs" | "profit" | "margin" | "turnover";
type Sort = SortState<SortKey>;

const COLS: { key: SortKey; label: string }[] = [
  { key: "stockEnd", label: "Остаток" },
  { key: "share", label: "Доля остатка" },
  { key: "revenue", label: "Продано" },
  { key: "cogs", label: "Себестоимость" },
  { key: "profit", label: "Валовая прибыль" },
  { key: "margin", label: "Валовый %" },
  { key: "turnover", label: "Оборачиваемость" },
];
const GRID = "grid-cols-[minmax(150px,1.6fr)_repeat(7,minmax(104px,1fr))]";

function sortValue(r: Row, key: SortKey, stockTotal: number): number | string | null {
  const m = metrics(r);
  switch (key) {
    case "name":
      return r.name;
    case "stockEnd":
      return r.stockEnd;
    case "share":
      return stockTotal > 0 ? r.stockEnd / stockTotal : 0;
    case "stockAvg":
      return r.stockAvg;
    case "revenue":
      return r.revenue;
    case "cogs":
      return r.cogs;
    case "profit":
      return m.profit;
    case "margin":
      return m.margin;
    case "turnover":
      return m.turnover;
  }
}

function Block({
  title,
  hint,
  rows,
  nameHeader,
  excluded,
  onToggle,
  prev,
}: {
  title: string;
  hint: string;
  rows: Row[];
  nameHeader: string;
  excluded?: Set<string>; // выключенные галочками строки (только у блока с галочками)
  onToggle?: (name: string) => void;
  prev?: Row[] | null; // тот же разрез за предыдущий период (для разницы)
}) {
  const [sort, setSort] = useState<Sort>(null);
  const selectable = !!onToggle;
  const isOn = (name: string) => !excluded?.has(name);
  const sum = total(selectable ? rows.filter((r) => isOn(r.name)) : rows);
  const sumM = metrics(sum);
  const prevMap = new Map((prev ?? []).map((r) => [r.name, r]));
  const prevSum = prev ? total(selectable ? prev.filter((r) => isOn(r.name)) : prev) : null;
  const prevSumM = prevSum ? metrics(prevSum) : null;
  const sorted = useMemo(() => {
    const base = [...rows];
    if (!sort) return base.sort((a, b) => b.stockEnd - a.stockEnd);
    return base.sort((a, b) => {
      const x = sortValue(a, sort.key, sum.stockEnd);
      const y = sortValue(b, sort.key, sum.stockEnd);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp = typeof x === "string" ? x.localeCompare(y as string, "ru") : (x as number) - (y as number);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);

  const head = (key: SortKey, label: string, left?: boolean) => <SortHead key={key} label={label} k={key} sort={sort} onSort={setSort} left={left} />;

  return (
    <section className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
      <div>
        <h2 className="font-serif text-[20px] font-semibold m-0">{title}</h2>
        <p className="text-[13px] text-muted mt-1">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Нет данных за выбранный период.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[900px]">
            <div className={`grid ${GRID} gap-3 pb-2 text-[11px] font-semibold text-muted border-b border-border`}>
              {head("name", nameHeader, true)}
              {COLS.map((c) => head(c.key, c.label))}
            </div>
            {sorted.map((r) => {
              const m = metrics(r);
              const pr = prev ? prevMap.get(r.name) : undefined;
              const pm = pr ? metrics(pr) : null;
              const cmp = (cur: number | null, old: number | null | undefined) => (prev ? <Delta v={pr ? deltaPct(cur, old) : null} /> : null);
              return (
                <div key={r.name} className={`grid ${GRID} gap-3 py-2.5 items-center text-[13px] border-b border-border/60 ${selectable && !isOn(r.name) ? "opacity-45" : ""}`}>
                  {selectable ? (
                    <label className="flex items-center gap-2 font-medium break-words cursor-pointer">
                      <input type="checkbox" className="accent-accent flex-none" checked={isOn(r.name)} onChange={() => onToggle?.(r.name)} />
                      {r.name}
                    </label>
                  ) : (
                    <div className="font-medium break-words">{r.name}</div>
                  )}
                  <div className="num text-right">{money(r.stockEnd)}{cmp(r.stockEnd, pr?.stockEnd)}</div>
                  <div className="num text-right text-muted">{pctText(sum.stockEnd > 0 ? (r.stockEnd / sum.stockEnd) * 100 : null)}</div>
                  <div className="num text-right">{money(r.revenue)}{cmp(r.revenue, pr?.revenue)}</div>
                  <div className="num text-right">{money(r.cogs)}{cmp(r.cogs, pr?.cogs)}</div>
                  <div className={`num text-right font-semibold ${m.profit < 0 ? "text-[#A34B36]" : ""}`}>{money(m.profit)}{cmp(m.profit, pm?.profit)}</div>
                  <div className="num text-right text-muted"><span className={lowMargin(m.margin) ? LOW_MARGIN_CLS : ""}>{pctText(m.margin)}</span>{cmp(m.margin, pm?.margin)}</div>
                  <div className="num text-right">{pctText(m.turnover)}{cmp(m.turnover, pm?.turnover)}</div>
                </div>
              );
            })}
            <div className={`grid ${GRID} gap-3 py-3 items-center text-[13px] font-bold bg-paper`}>
              <div className="pl-2">Итого</div>
              <div className="num text-right">{money(sum.stockEnd)}{prevSum && <Delta v={deltaPct(sum.stockEnd, prevSum.stockEnd)} />}</div>
              <div className="num text-right text-muted">{sum.stockEnd > 0 ? "100,0%" : "—"}</div>
              <div className="num text-right">{money(sum.revenue)}{prevSum && <Delta v={deltaPct(sum.revenue, prevSum.revenue)} />}</div>
              <div className="num text-right">{money(sum.cogs)}{prevSum && <Delta v={deltaPct(sum.cogs, prevSum.cogs)} />}</div>
              <div className="num text-right">{money(sumM.profit)}{prevSumM && <Delta v={deltaPct(sumM.profit, prevSumM.profit)} />}</div>
              <div className="num text-right text-muted"><span className={lowMargin(sumM.margin) ? LOW_MARGIN_CLS : ""}>{pctText(sumM.margin)}</span>{prevSumM && <Delta v={deltaPct(sumM.margin, prevSumM.margin)} />}</div>
              <div className="num text-right">{pctText(sumM.turnover)}{prevSumM && <Delta v={deltaPct(sumM.turnover, prevSumM.turnover)} />}</div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default function WarehouseOverviewPage() {
  const { isAdmin, permissions, accessibleStoreCodes } = useAuth();
  const canView = isAdmin || permissions["warehouse.overview"].canView;

  const stocked = useStockedWarehouses();
  const accessibleWarehouseCodes = warehousesForCities(accessibleStoreCodes).filter((c) => !stocked || stocked.has(c));
  const frozenAvailable = !stocked || stocked.has("frozen");
  const [storeFilter, setStoreFilter] = useState<string[]>([]);
  const [frozen, setFrozen] = useState(false); // заморозка — отдельная корзина остатков, по умолчанию выключена
  const baseStores = storeFilter.length > 0 ? storeFilter : accessibleWarehouseCodes;
  const stores = useMemo(() => (frozen && frozenAvailable ? [...baseStores, "frozen"] : baseStores), [baseStores, frozen, frozenAvailable]);
  const storesKey = stores.join(",");

  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => {
    const t = new Date();
    return { from: ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6)), to: ymd(t) };
  });
  const range = rangeOf(period, custom);
  const prevRange = prevRangeOf(period, range);

  const [byCategory, setByCategory] = useState<Row[]>([]);
  // категории, выключенные галочками (по умолчанию — «Бесплатный» и «Без категории»); итоги блока и карточек считаются по включённым
  const [excludedCategories, setExcludedCategories] = useState<Set<string>>(() => new Set(["Бесплатный", "Без категории"]));
  function toggleCategory(name: string) {
    setExcludedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  const categoriesOn = byCategory.filter((r) => !excludedCategories.has(r.name));
  const [bySupplier, setBySupplier] = useState<Row[]>([]);
  const [byStore, setByStore] = useState<Row[]>([]);
  // то же за предыдущий период — для разницы (null — период без сравнения или данные ещё не пришли)
  const [prevData, setPrevData] = useState<{ cat: Row[]; sup: Row[]; sto: Row[] } | null>(null);
  // кнопка «Показать разницу» — по умолчанию выключена; в PDF сравнение выбирается галочкой в окне «Что скачать» независимо от неё
  const [showDiff, setShowDiff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

    // выключенные галочками категории (названия на экране → верхние категории каталога, как их хранит база)
    const exclude = [...excludedCategories].map((label) => TOP_CATEGORIES.find((c) => c.label === label)?.key ?? label);
    type Cat = { category: string; cogs: number; stock_value: number; revenue: number; stock_value_end: number };
    type Sup = { supplier_name: string; revenue: number; cogs: number; stock_value: number; stock_value_end: number };
    type Sto = { store: string; revenue: number; cogs: number; stock_value: number; stock_value_end: number };
    const label = (key: string) => TOP_CATEGORIES.find((c) => c.key === key)?.label ?? key;
    const order = (key: string) => {
      const i = TOP_CATEGORIES.findIndex((c) => c.key === key);
      return i === -1 ? 99 : i;
    };
    const mk = (name: string, r: { stock_value_end: number; stock_value: number; revenue: number; cogs: number }): Row => ({
      name,
      stockEnd: Number(r.stock_value_end),
      stockAvg: Number(r.stock_value),
      revenue: Number(r.revenue),
      cogs: Number(r.cogs),
    });
    async function fetchSet(from: string, to: string) {
      const args = { p_stores: stores, p_from: from, p_to: to };
      const argsEx = { ...args, p_exclude: exclude };
      const [cat, sup, sto] = await Promise.all([
        fetchAllRows<Cat>((a, b) => supabase.rpc("stock_turnover_by_category", args).range(a, b)),
        fetchAllRows<Sup>((a, b) => supabase.rpc("warehouse_overview_by_supplier", argsEx).range(a, b)),
        fetchAllRows<Sto>((a, b) => supabase.rpc("warehouse_overview_by_store", argsEx).range(a, b)),
      ]);
      return {
        cat: [...cat].sort((x, y) => order(x.category) - order(y.category)).map((r) => mk(label(r.category), r)),
        sup: sup.map((r) => mk(r.supplier_name, r)),
        sto: sto
          .filter((r) => Number(r.stock_value_end) !== 0 || Number(r.stock_value) !== 0 || Number(r.revenue) !== 0 || Number(r.cogs) !== 0)
          .map((r) => mk(WAREHOUSES.find((w) => w.code === r.store)?.label ?? (r.store === "frozen" ? "Заморозка" : r.store), r)),
      };
    }

  useEffect(() => {
    if (!canView) return;
    if (stores.length === 0) {
      setByCategory([]);
      setBySupplier([]);
      setByStore([]);
      setLoading(false);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    if (!showDiff) setPrevData(null);
    (async () => {
      try {
        const [now, before] = await Promise.all([fetchSet(range.from, range.to), showDiff && prevRange ? fetchSet(prevRange.from, prevRange.to) : Promise.resolve(null)]);
        if (my !== seq.current) return;
        setByCategory(now.cat);
        setBySupplier(now.sup);
        setByStore(now.sto);
        setPrevData(before);
      } catch (e) {
        if (my === seq.current) setError(getErrorMessage(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, storesKey, range.from, range.to, showDiff, prevRange?.from, prevRange?.to, [...excludedCategories].sort().join("|")]);

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Склад».</p>
      </div>
    );
  }

  const sum = total(byCategory.length > 0 ? categoriesOn : byStore);
  const sumM = metrics(sum);
  const diffOn = showDiff && !!prevRange && !!prevData;
  const prevCategoriesOn = prevData ? prevData.cat.filter((r) => !excludedCategories.has(r.name)) : null;
  const prevSum = prevData ? total(prevCategoriesOn && prevCategoriesOn.length > 0 ? prevCategoriesOn : prevData.sto) : null;
  const prevSumM = prevSum ? metrics(prevSum) : null;
  const storeLabels = stores.filter((c) => c !== "saya_park").map((c) => WAREHOUSES.find((w) => w.code === c)?.label ?? (c === "frozen" ? "Заморозка" : c));

  function toggleStore(code: string) {
    setStoreFilter((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  // разница к предыдущему периоду по метрикам строки (в том же порядке, что и колонки): остаток, продано, себестоимость, валовая прибыль, валовый %, оборачиваемость
  const deltasOf = (r: Row, pr: Row | null | undefined): (number | null)[] => {
    if (!pr) return [null, null, null, null, null, null];
    const m = metrics(r);
    const pm = metrics(pr);
    return [deltaPct(r.stockEnd, pr.stockEnd), deltaPct(r.revenue, pr.revenue), deltaPct(r.cogs, pr.cogs), deltaPct(m.profit, pm.profit), deltaPct(m.margin, pm.margin), deltaPct(m.turnover, pm.turnover)];
  };
  const metricCells = (r: Row): string[] => {
    const m = metrics(r);
    return [money(r.stockEnd), money(r.revenue), money(r.cogs), money(m.profit), pctText(m.margin), pctText(m.turnover)];
  };
  const tableRow = (r: Row): (string | number)[] => [r.name, ...metricCells(r)];
  const plain2 = (n: number) => trim2Ru(n);
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
  const excelRow = (r: Row, pr?: Row | null): (string | number)[] => {
    const m = metrics(r);
    const base: (string | number)[] = [r.name, Math.round(r.stockEnd * 100) / 100, Math.round(r.revenue * 100) / 100, Math.round(r.cogs * 100) / 100, Math.round(m.profit * 100) / 100, m.margin === null ? "" : Math.round(m.margin * 10) / 10, m.turnover === null ? "" : Math.round(m.turnover * 10) / 10];
    if (!diffOn) return base;
    return [...base, ...deltasOf(r, pr).map((v) => (v === null ? "" : Math.round(v * 100) / 100))];
  };
  type PrevSet = { cat: Row[]; sup: Row[]; sto: Row[] };
  const blockPrev = (b: { nameHeader: string }, d: PrevSet | null = prevData) => (d ? (b.nameHeader === "Категория" ? d.cat : b.nameHeader === "Поставщик" ? d.sup : d.sto) : null);
  const prevOf = (b: { nameHeader: string }, d: PrevSet | null = prevData) => new Map((blockPrev(b, d) ?? []).map((r) => [r.name, r]));
  const totalPrev = (b: { nameHeader: string; rows: Row[] }, d: PrevSet | null = prevData): Row | null => {
    const pr = blockPrev(b, d);
    if (!pr) return null;
    // у блока категорий в итог входят только включённые строки (b.rows уже отфильтрованы) — для прошлого периода те же категории
    const names = new Set(b.rows.map((r) => r.name));
    return total(b.nameHeader === "Категория" ? pr.filter((r) => names.has(r.name)) : pr);
  };
  const blocks: { title: string; nameHeader: string; rows: Row[] }[] = [
    { title: "По категориям", nameHeader: "Категория", rows: categoriesOn },
    { title: "По поставщикам", nameHeader: "Поставщик", rows: bySupplier },
    ...(storeLabels.length > 1 ? [{ title: "По складам", nameHeader: "Склад", rows: byStore }] : []), // один склад — таблицы «По складам» нет
  ];
  const excelHeaders = (first: string) => [
    first,
    "Остаток (себестоимость)",
    "Продано (выручка)",
    "Себестоимость продаж",
    "Валовая прибыль",
    "Валовый, %",
    "Оборачиваемость, %",
    ...(diffOn ? ["Остаток, разница %", "Продано, разница %", "Себестоимость, разница %", "Валовая прибыль, разница %", "Валовый, разница %", "Оборачиваемость, разница %"] : []),
  ];

  // Блоки «Сравнение периодов» для PDF (по галочке в окне «Что скачать», по умолчанию выключены). Как в недельном отчёте: у каждого показателя три колонки —
  // предыдущий период, выбранный и разница (цифра и % — двумя строками). Показатели: остаток, продано, валовая прибыль, оборачиваемость.
  const comparisonSections = (d: PrevSet | null): PdfSection[] => {
    if (!prevRange || !d) return [];
    // подписи колонок — конкретные даты периодов (один день — «12.10.2026», период — две строки «01.09.26 –» / «30.09.26»)
    const dateLabel = (from: string, to: string) => {
      if (from === to) return fmtRuDate(from);
      const short = (iso: string) => fmtRuDate(iso).replace(/\.20(\d\d)$/, ".$1");
      return `${short(from)} –\n${short(to)}`;
    };
    const subs = [dateLabel(prevRange.from, prevRange.to), dateLabel(range.from, range.to), "Разница"];
    const groups = ["Остаток, ₸", "Продано, ₸", "Валовая прибыль, ₸", "Оборачиваемость, %"];
    const widths = [2.1, 1.45, 1.45, 1.5, 1.45, 1.45, 1.5, 1.45, 1.45, 1.5, 0.9, 0.9, 1.25];
    // показатели строки: остаток, продано, валовая прибыль — деньги; оборачиваемость — %
    const vals = (r: Row): (number | null)[] => [r.stockEnd, r.revenue, r.revenue - r.cogs, metrics(r).turnover];
    const cells = (r: Row, pr: Row | null | undefined): string[] => {
      const cur = vals(r);
      const old = pr ? vals(pr) : null;
      const out: string[] = [];
      cur.forEach((c, i) => {
        const isPct = i === 3;
        const fmt = (n: number | null) => (n === null ? "—" : isPct ? pctText(n) : plain2(n));
        const o = old ? old[i] : null;
        let diff = "—";
        if (c !== null && o !== null) {
          const abs = c - o;
          // знак — по округлённому значению, чтобы «+0,0» не появлялось
          const rounded = Math.round(abs * 100) / 100;
          const absText = isPct ? `${sign(rounded)}${trim2Ru(Math.abs(rounded))} п.п.` : `${sign(rounded)}${plain2(Math.abs(rounded))}`;
          diff = `${absText}
${deltaText(deltaPct(c, o))}`;
        }
        out.push(fmt(o), fmt(c), diff);
      });
      return out;
    };
    return blocks.map((b) => {
      const pm = prevOf(b, d);
      const cur = [...b.rows].sort((x, y) => y.stockEnd - x.stockEnd);
      const prevRows = cur.map((r) => pm.get(r.name)).filter((r): r is Row => !!r);
      const rows: (string | number)[][] = cur.map((r) => [r.name, ...cells(r, pm.get(r.name))]);
      rows.push(["Итого", ...cells(total(b.rows), totalPrev(b, d) ?? total(prevRows))]);
      return {
        title: `${b.title} — сравнение периодов`,
        hint: "По каждому показателю: предыдущий период, выбранный и разница (цифра и %), как в недельном отчёте.",
        note: `Слева — предыдущий период (${prevRange.label}), справа — выбранный (${range.label}). Разница — выбранный минус предыдущий; у оборачиваемости — в процентных пунктах и в %.`,
        optional: true,
        headers: [b.nameHeader, ...groups.flatMap((g) => subs.map((sName) => `${g.split(",")[0]} · ${sName.replace("\n", " ")}`))],
        headGroups: [{ label: b.nameHeader, span: 1 }, ...groups.map((g) => ({ label: g, span: 3, subs }))],
        rows,
        rowKinds: rows.map((_, i) => (i === rows.length - 1 ? ("total" as const) : ("normal" as const))),
        widths,
        fontSize: 7.2,
        grid: true,
        align: ["left", ...Array.from({ length: 12 }, () => "center" as const)],
        signColors: true,
      };
    });
  };

  function exportXls() {
    const rows: (string | number)[][] = [];
    const width = excelHeaders("").length;
    const blank = Array.from({ length: width }, () => "");
    for (const b of blocks) {
      const pm = prevOf(b);
      rows.push([`— ${b.title} —`, ...blank.slice(1)]);
      rows.push(excelHeaders(b.nameHeader));
      rows.push(...[...b.rows].sort((x, y) => y.stockEnd - x.stockEnd).map((r) => excelRow(r, pm.get(r.name))));
      rows.push(excelRow(total(b.rows), totalPrev(b)));
      rows.push(blank);
    }
    downloadExcel("Склад_обзор", excelHeaders("Название"), rows);
  }

  const checkbox = "flex items-center gap-1.5 text-[13px] cursor-pointer";
  const kpi = (label: string, value: string, note?: string, delta?: number | null) => (
    <div className="bg-surface border border-border rounded-card px-5 py-4 flex flex-col gap-1 min-w-0">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="num text-[20px] font-semibold break-words">{value}</div>
      {delta !== undefined && <Delta v={delta} />}
      {note && <div className="text-[11px] text-mutedLight">{note}</div>}
    </div>
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Склад</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Обзор</h1>
        <p className="text-sm text-muted max-w-2xl mt-1">
          Остаток, продажи, валовая прибыль и оборачиваемость в разрезе категорий, поставщиков и складов. Остаток — по факту на последний день периода
          (как в МойСклад), оборачиваемость — себестоимость продаж ÷ средний остаток за период.
        </p>
        {error && <div className="text-sm text-[#A34B36]">Не удалось загрузить: {error}</div>}
      </div>

      <div className="flex items-end gap-5 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted">Период</span>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={String(period)}
              onChange={(e) => setPeriod(e.target.value === "custom" ? "custom" : Number(e.target.value))}
              className="bg-paper border border-border rounded-lg px-3 py-2 text-[13px]"
            >
              {PERIODS.map((label, i) => (
                <option key={label} value={i}>
                  {label}
                </option>
              ))}
              <option value="custom">Свой период</option>
            </select>
            {period === "custom" && (
              <>
                <input type="date" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((r) => ({ ...r, from: e.target.value }))} className="bg-paper border border-border rounded-lg px-2 py-1.5 text-[13px]" />
                <span className="text-muted">—</span>
                <input type="date" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom((r) => ({ ...r, to: e.target.value }))} className="bg-paper border border-border rounded-lg px-2 py-1.5 text-[13px]" />
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted">Склады</span>
          <div className="flex items-center gap-4 flex-wrap">
            {FILTER_WAREHOUSES.filter((w) => accessibleWarehouseCodes.includes(w.code)).map((w) => (
              <label key={w.code} className={checkbox}>
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={storeFilter.length === 0 || storeFilter.includes(w.code)}
                  onChange={() => {
                    if (storeFilter.length === 0) setStoreFilter(accessibleWarehouseCodes.filter((c) => c !== w.code && c !== "saya_park"));
                    else toggleStore(w.code);
                  }}
                />
                {w.label}
              </label>
            ))}
            {frozenAvailable && (
              <label className={checkbox}>
                <input type="checkbox" className="accent-accent" checked={frozen} onChange={(e) => setFrozen(e.target.checked)} />
                Заморозка
              </label>
            )}
          </div>
        </div>
        <label className={`${checkbox} pb-2`} title="Сравнить с предыдущим периодом такой же длины">
          <input type="checkbox" className="accent-accent" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
          Показать разницу
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportXls}
            disabled={byCategory.length === 0 && bySupplier.length === 0}
            className="text-[13px] font-semibold text-accent bg-surface border border-border rounded-md px-3.5 py-2 hover:bg-paper disabled:opacity-50"
          >
            Скачать Excel
          </button>
          <PdfButton
            disabled={byCategory.length === 0 && bySupplier.length === 0}
            build={async (): Promise<PdfDoc> => {
              const cmpData = prevData ?? (prevRange ? await fetchSet(prevRange.from, prevRange.to) : null);
              return {
              fileName: `Склад обзор ${ruPeriod(range.from, range.to)}`,
              orientation: "landscape",
              title: "Склад — обзор",
              subtitle: `Период: ${range.label} · склады: ${storeLabels.join(", ")}`,
              meta: [
                "Остаток — по факту на последний день периода, как в МойСклад",
                "Оборачиваемость — себестоимость продаж ÷ средний остаток за период",
                "Валовая прибыль — продано минус себестоимость продаж",
              ],
              kpis: [
                { label: "Остаток", value: money(sum.stockEnd) },
                { label: "Продано", value: money(sum.revenue) },
                { label: "Валовая прибыль", value: money(sumM.profit) },
                { label: "Оборачиваемость", value: pctText(sumM.turnover) },
              ],
              sections: [...blocks.map((b) => {
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
              }), ...comparisonSections(cmpData)],
              };
            }}
          />
        </div>
      </div>

      <div className="text-xs text-muted">
        Период: {range.label}
        {showDiff ? (prevRange ? ` · разница к периоду ${prevRange.label}` : " · для «Всё время» разницы нет") : ""}
        {loading && " · загрузка…"}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpi("Остаток (себестоимость)", money(sum.stockEnd), "по факту на конец периода", prevSum ? deltaPct(sum.stockEnd, prevSum.stockEnd) : undefined)}
        {kpi("Продано", money(sum.revenue), `себестоимость ${money(sum.cogs)}`, prevSum ? deltaPct(sum.revenue, prevSum.revenue) : undefined)}
        {kpi("Валовая прибыль", money(sumM.profit), sumM.margin === null ? undefined : `валовый ${pctText(sumM.margin)}`, prevSumM ? deltaPct(sumM.profit, prevSumM.profit) : undefined)}
        {kpi("Оборачиваемость", pctText(sumM.turnover), undefined, prevSumM ? deltaPct(sumM.turnover, prevSumM.turnover) : undefined)}
      </div>

      {blocks.map((b) => (
        <Block
          key={b.title}
          title={b.title}
          nameHeader={b.nameHeader}
          rows={b.nameHeader === "Категория" ? byCategory : b.rows}
          excluded={b.nameHeader === "Категория" ? excludedCategories : undefined}
          onToggle={b.nameHeader === "Категория" ? toggleCategory : undefined}
          prev={showDiff && prevData ? (b.nameHeader === "Категория" ? prevData.cat : b.nameHeader === "Поставщик" ? prevData.sup : prevData.sto) : null}
          hint={
            b.nameHeader === "Поставщик"
              ? "Поставщик — из карточки товара в МойСклад. Стрелки у колонок — сортировка."
              : b.nameHeader === "Склад"
              ? "Каждый склад отдельно (заморозка — отдельная корзина остатков). Стрелки у колонок — сортировка."
              : "Верхние категории каталога. Галочки — какие категории учитывать: от них зависят итоги, карточки и таблицы «По поставщикам» и «По складам». Стрелки у колонок — сортировка."
          }
        />
      ))}
    </>
  );
}
