"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { downloadExcel } from "@/lib/exportExcel";
import { WAREHOUSES, FILTER_WAREHOUSES, warehousesForCities } from "@/lib/warehouses";
import { useStockedWarehouses } from "@/lib/useStockedWarehouses";
import PdfButton from "@/components/PdfButton";
import SortHead, { type SortState } from "@/components/SortHead";
import type { PdfDoc } from "@/lib/downloadPdf";

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
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₸`;
}
function pctText(v: number | null, digits = 1) {
  return v === null ? "—" : `${v.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
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
  { key: "stockAvg", label: "Ср. остаток" },
  { key: "revenue", label: "Продано" },
  { key: "cogs", label: "Себестоимость" },
  { key: "profit", label: "Валовая прибыль" },
  { key: "margin", label: "Валовый %" },
  { key: "turnover", label: "Оборачиваемость" },
];
const GRID = "grid-cols-[minmax(150px,1.6fr)_repeat(8,minmax(104px,1fr))]";

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
}: {
  title: string;
  hint: string;
  rows: Row[];
  nameHeader: string;
  excluded?: Set<string>; // выключенные галочками строки (только у блока с галочками)
  onToggle?: (name: string) => void;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const selectable = !!onToggle;
  const isOn = (name: string) => !excluded?.has(name);
  const sum = total(selectable ? rows.filter((r) => isOn(r.name)) : rows);
  const sumM = metrics(sum);
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
          <div className="min-w-[1000px]">
            <div className={`grid ${GRID} gap-3 pb-2 text-[11px] font-semibold text-muted border-b border-border`}>
              {head("name", nameHeader, true)}
              {COLS.map((c) => head(c.key, c.label))}
            </div>
            {sorted.map((r) => {
              const m = metrics(r);
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
                  <div className="num text-right">{money(r.stockEnd)}</div>
                  <div className="num text-right text-muted">{pctText(sum.stockEnd > 0 ? (r.stockEnd / sum.stockEnd) * 100 : null)}</div>
                  <div className="num text-right text-muted">{money(r.stockAvg)}</div>
                  <div className="num text-right">{money(r.revenue)}</div>
                  <div className="num text-right">{money(r.cogs)}</div>
                  <div className={`num text-right font-semibold ${m.profit < 0 ? "text-[#A34B36]" : ""}`}>{money(m.profit)}</div>
                  <div className="num text-right text-muted">{pctText(m.margin)}</div>
                  <div className="num text-right">{pctText(m.turnover)}</div>
                </div>
              );
            })}
            <div className={`grid ${GRID} gap-3 py-3 items-center text-[13px] font-bold bg-paper`}>
              <div className="pl-2">Итого</div>
              <div className="num text-right">{money(sum.stockEnd)}</div>
              <div className="num text-right text-muted">{sum.stockEnd > 0 ? "100,0%" : "—"}</div>
              <div className="num text-right">{money(sum.stockAvg)}</div>
              <div className="num text-right">{money(sum.revenue)}</div>
              <div className="num text-right">{money(sum.cogs)}</div>
              <div className="num text-right">{money(sumM.profit)}</div>
              <div className="num text-right text-muted">{pctText(sumM.margin)}</div>
              <div className="num text-right">{pctText(sumM.turnover)}</div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default function WarehouseOverviewPage() {
  const { isAdmin, permissions, accessibleStoreCodes } = useAuth();
  const canView = isAdmin || permissions["warehouse.stock"].canView;

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

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
    (async () => {
      try {
        const args = { p_stores: stores, p_from: range.from, p_to: range.to };
        // выключенные галочками категории (названия на экране → верхние категории каталога, как их хранит база)
        const exclude = [...excludedCategories].map((label) => TOP_CATEGORIES.find((c) => c.label === label)?.key ?? label);
        const argsEx = { ...args, p_exclude: exclude };
        type Cat = { category: string; cogs: number; stock_value: number; revenue: number; stock_value_end: number };
        type Sup = { supplier_name: string; revenue: number; cogs: number; stock_value: number; stock_value_end: number };
        type Sto = { store: string; revenue: number; cogs: number; stock_value: number; stock_value_end: number };
        const [cat, sup, sto] = await Promise.all([
          fetchAllRows<Cat>((a, b) => supabase.rpc("stock_turnover_by_category", args).range(a, b)),
          fetchAllRows<Sup>((a, b) => supabase.rpc("warehouse_overview_by_supplier", argsEx).range(a, b)),
          fetchAllRows<Sto>((a, b) => supabase.rpc("warehouse_overview_by_store", argsEx).range(a, b)),
        ]);
        if (my !== seq.current) return;
        const label = (key: string) => TOP_CATEGORIES.find((c) => c.key === key)?.label ?? key;
        const order = (key: string) => {
          const i = TOP_CATEGORIES.findIndex((c) => c.key === key);
          return i === -1 ? 99 : i;
        };
        setByCategory(
          [...cat]
            .sort((x, y) => order(x.category) - order(y.category))
            .map((r) => ({ name: label(r.category), stockEnd: Number(r.stock_value_end), stockAvg: Number(r.stock_value), revenue: Number(r.revenue), cogs: Number(r.cogs) }))
        );
        setBySupplier(sup.map((r) => ({ name: r.supplier_name, stockEnd: Number(r.stock_value_end), stockAvg: Number(r.stock_value), revenue: Number(r.revenue), cogs: Number(r.cogs) })));
        setByStore(
          sto
            .filter((r) => Number(r.stock_value_end) !== 0 || Number(r.stock_value) !== 0 || Number(r.revenue) !== 0 || Number(r.cogs) !== 0)
            .map((r) => ({
            name: WAREHOUSES.find((w) => w.code === r.store)?.label ?? (r.store === "frozen" ? "Заморозка" : r.store),
            stockEnd: Number(r.stock_value_end),
            stockAvg: Number(r.stock_value),
            revenue: Number(r.revenue),
            cogs: Number(r.cogs),
          }))
        );
      } catch (e) {
        if (my === seq.current) setError(getErrorMessage(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, storesKey, range.from, range.to, [...excludedCategories].sort().join("|")]);

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Склад».</p>
      </div>
    );
  }

  const sum = total(byCategory.length > 0 ? categoriesOn : byStore);
  const sumM = metrics(sum);
  const storeLabels = stores.map((c) => WAREHOUSES.find((w) => w.code === c)?.label ?? (c === "frozen" ? "Заморозка" : c));

  function toggleStore(code: string) {
    setStoreFilter((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  const tableRow = (r: Row): (string | number)[] => {
    const m = metrics(r);
    return [r.name, money(r.stockEnd), money(r.stockAvg), money(r.revenue), money(r.cogs), money(m.profit), pctText(m.margin), pctText(m.turnover)];
  };
  const excelRow = (r: Row): (string | number)[] => {
    const m = metrics(r);
    return [r.name, Math.round(r.stockEnd * 100) / 100, Math.round(r.stockAvg * 100) / 100, Math.round(r.revenue * 100) / 100, Math.round(r.cogs * 100) / 100, Math.round(m.profit * 100) / 100, m.margin === null ? "" : Math.round(m.margin * 10) / 10, m.turnover === null ? "" : Math.round(m.turnover * 10) / 10];
  };
  const blocks: { title: string; nameHeader: string; rows: Row[] }[] = [
    { title: "По категориям", nameHeader: "Категория", rows: categoriesOn },
    { title: "По поставщикам", nameHeader: "Поставщик", rows: bySupplier },
    { title: "По складам", nameHeader: "Склад", rows: byStore },
  ];
  const excelHeaders = (first: string) => [first, "Остаток (себестоимость)", "Средний остаток", "Продано (выручка)", "Себестоимость продаж", "Валовая прибыль", "Валовый, %", "Оборачиваемость, %"];

  function exportXls() {
    const rows: (string | number)[][] = [];
    for (const b of blocks) {
      rows.push([`— ${b.title} —`, "", "", "", "", "", "", ""]);
      rows.push(excelHeaders(b.nameHeader));
      rows.push(...[...b.rows].sort((x, y) => y.stockEnd - x.stockEnd).map(excelRow));
      rows.push(excelRow(total(b.rows)));
      rows.push(["", "", "", "", "", "", "", ""]);
    }
    downloadExcel("Склад_обзор", excelHeaders("Название"), rows);
  }

  const checkbox = "flex items-center gap-1.5 text-[13px] cursor-pointer";
  const kpi = (label: string, value: string, note?: string) => (
    <div className="bg-surface border border-border rounded-card px-5 py-4 flex flex-col gap-1 min-w-0">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="num text-[20px] font-semibold break-words">{value}</div>
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
            build={(): PdfDoc => ({
              fileName: "Склад_обзор",
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
              sections: blocks.map((b) => {
                const sorted = [...b.rows].sort((x, y) => y.stockEnd - x.stockEnd);
                const body = [...sorted.map(tableRow), tableRow(total(b.rows))];
                return {
                  title: b.title,
                  headers: [b.nameHeader, "Остаток", "Ср. остаток", "Продано", "Себестоимость", "Валовая прибыль", "Валовый %", "Оборачиваемость"],
                  rows: body,
                  rowKinds: body.map((_, i) => (i === body.length - 1 ? "total" : "normal")),
                  widths: [2.4, 1.6, 1.6, 1.6, 1.6, 1.6, 0.9, 1.3],
                };
              }),
            })}
          />
        </div>
      </div>

      <div className="text-xs text-muted">
        Период: {range.label}
        {loading && " · загрузка…"}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpi("Остаток (себестоимость)", money(sum.stockEnd), "по факту на конец периода")}
        {kpi("Продано", money(sum.revenue), `себестоимость ${money(sum.cogs)}`)}
        {kpi("Валовая прибыль", money(sumM.profit), sumM.margin === null ? undefined : `валовый ${pctText(sumM.margin)}`)}
        {kpi("Оборачиваемость", pctText(sumM.turnover), `средний остаток ${money(sum.stockAvg)}`)}
      </div>

      {blocks.map((b) => (
        <Block
          key={b.title}
          title={b.title}
          nameHeader={b.nameHeader}
          rows={b.nameHeader === "Категория" ? byCategory : b.rows}
          excluded={b.nameHeader === "Категория" ? excludedCategories : undefined}
          onToggle={b.nameHeader === "Категория" ? toggleCategory : undefined}
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
