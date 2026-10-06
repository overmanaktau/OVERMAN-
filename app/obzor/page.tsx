"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { SalesPlanWindow, type PlanRange } from "@/components/SalesPlanWindow";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { warehousesForCities } from "@/lib/warehouses";
import PdfButton from "@/components/PdfButton";
import type { PdfDoc } from "@/lib/downloadPdf";

const PERIODS = ["Вчера", "Прошлая неделя", "Эта неделя", "С начала месяца", "Прошлый месяц", "Всё время"];
const DEFAULT_PERIOD = 3; // "С начала месяца"

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function ymd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}
function stripTime(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

type Range = { start: Date; end: Date };

function getPeriodRange(index: number, today: Date): Range {
  const d = stripTime(today);
  const dow = d.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = addDays(d, mondayOffset);
  const thisSunday = addDays(thisMonday, 6);

  if (index === 0) return { start: addDays(d, -1), end: addDays(d, -1) }; // Вчера
  if (index === 1) return { start: addDays(thisMonday, -7), end: addDays(thisSunday, -7) };
  if (index === 2) return { start: thisMonday, end: thisSunday };
  if (index === 3) return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: d }; // С начала месяца
  if (index === 4) {
    // Прошлый месяц
    return { start: new Date(d.getFullYear(), d.getMonth() - 1, 1), end: new Date(d.getFullYear(), d.getMonth(), 0) };
  }
  return { start: new Date(2000, 0, 1), end: d }; // Всё время
}

function parseYmd(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}
function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером базы данных. Проверьте интернет-соединение и попробуйте снова.";
  }
  return `Не удалось выполнить операцию: ${message}`;
}

// Rounds a raw max value up to a "clean" number for the chart's top
// gridline (e.g. 1,842,000 → 2,000,000) so the axis reads like a real
// dashboard instead of an arbitrary data-driven ceiling.
function niceMax(raw: number): number {
  if (raw <= 0) return 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

type DayPoint = { date: string; label: string; revenue: number };

function RevenueChart({ points }: { points: DayPoint[] }) {
  const width = 900;
  const height = 260;
  const marginLeft = 64;
  const marginRight = 12;
  const marginTop = 12;
  const marginBottom = 28;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const maxRevenue = niceMax(Math.max(1, ...points.map((p) => p.revenue)));
  const gridLines = 5;

  function x(i: number) {
    return points.length <= 1 ? marginLeft : marginLeft + (i / (points.length - 1)) * plotWidth;
  }
  function y(value: number) {
    return marginTop + plotHeight - (value / maxRevenue) * plotHeight;
  }

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.revenue).toFixed(1)}`).join(" ");

  // Show roughly one label every 4 points, like a real chart legend —
  // showing all ~90 day labels would just overlap into an unreadable smear.
  const labelEvery = Math.max(1, Math.ceil(points.length / 22));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      {Array.from({ length: gridLines + 1 }, (_, i) => {
        const value = (maxRevenue / gridLines) * i;
        const yPos = y(value);
        return (
          <g key={i}>
            <line
              x1={marginLeft}
              x2={width - marginRight}
              y1={yPos}
              y2={yPos}
              stroke="var(--chart-grid, #E4DFC8)"
              strokeWidth="1"
            />
            <text x={marginLeft - 8} y={yPos} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="currentColor" opacity="0.6">
              {Math.round(value).toLocaleString("ru-RU")}
            </text>
          </g>
        );
      })}

      {points.map((p, i) =>
        i % labelEvery === 0 ? (
          <text
            key={p.date}
            x={x(i)}
            y={height - 6}
            textAnchor="middle"
            fontSize="10"
            fill="currentColor"
            opacity="0.6"
          >
            {p.label}
          </text>
        ) : null
      )}

      {points.length > 0 && <path d={pathD} fill="none" stroke="var(--accent, #4E7C5B)" strokeWidth="2" />}
      {points.map((p, i) => (
        <circle key={p.date} cx={x(i)} cy={y(p.revenue)} r="2.5" fill="var(--accent, #4E7C5B)" />
      ))}
    </svg>
  );
}

function Kpi({ label, value, suffix }: { label: string; value: string; suffix?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-serif text-[26px] font-semibold num">{value}</div>
      {suffix}
    </div>
  );
}

// The ~28 raw МойСклад folders folded into the 5 buckets the business
// actually thinks in terms of. stock_turnover_by_category already groups by
// top_category (the root МойСклад folder each product sits under, resolved
// from the real folder hierarchy at sync time — see
// supabase/sql/054_top_category.sql) — so this is just the display label and
// fixed order for the 5 real root folders. Anything else (a product with no
// category, or sitting outside these 5 roots entirely, e.g. "Бесплатный")
// comes back from the RPC as its own row but is simply never looked up here,
// same as before.
const TOP_CATEGORIES: { key: string; label: string }[] = [
  { key: "Верхняя", label: "Верх" },
  { key: "Плечевая", label: "Плечевой" },
  { key: "Брюки", label: "Брюки" },
  { key: "Обувь", label: "Обувь" },
  { key: "Аксессуары", label: "Аксессуары" },
];

export default function ObzorPage() {
  const { isAdmin, permissions } = useAuth();
  const { selected: selectedStores } = useStoreSelection();
  const canView = isAdmin || permissions["marketing.statistics"].canView;

  const [periodIndex, setPeriodIndex] = useState(DEFAULT_PERIOD);
  const [activeCustom, setActiveCustom] = useState<{ start: string; end: string } | null>(null);
  // Окно «План продаж» следует за выбранным периодом; «С начала месяца» — обычное окно месяца.
  const planRange: PlanRange | null = (() => {
    if (!activeCustom && periodIndex === DEFAULT_PERIOD) return null;
    const r = activeCustom
      ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
      : getPeriodRange(periodIndex, new Date());
    return { from: ymd(r.start), to: ymd(r.end), label: activeCustom ? "Свой период" : PERIODS[periodIndex] };
  })();
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customPickerRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dayRows, setDayRows] = useState<{ date: string; revenue: number; receipts: number; items: number; cost: number | null }[]>([]);
  const [range, setRange] = useState<Range>(() => getPeriodRange(DEFAULT_PERIOD, new Date()));

  // Оборачиваемость = себестоимость проданного за период / себестоимость
  // текущего остатка × 100% — what share of the money now tied up in stock
  // got sold through in the selected period. Scoped to the same period as
  // the rest of the page (unlike the old stockDays-based version), so it
  // loads alongside range/selectedStores rather than independently.
  const [turnoverByBucket, setTurnoverByBucket] = useState<
    { label: string; cogs: number; stockValue: number; revenue: number; stockSaleValue: number }[]
  >([]);
  const [turnoverLoading, setTurnoverLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTurnoverLoading(true);
      const warehouseCodes = warehousesForCities(selectedStores);
      const r = activeCustom
        ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
        : getPeriodRange(periodIndex, new Date());
      if (warehouseCodes.length === 0) {
        if (!cancelled) {
          setTurnoverByBucket([]);
          setTurnoverLoading(false);
        }
        return;
      }
      // Aggregated server-side (see stock_turnover_by_category in
      // supabase/sql/054_top_category.sql) — moysklad_product_stock and
      // moysklad_product_sales_daily both run into the thousands of rows,
      // well past PostgREST's default 1000-row page cap, so summing
      // client-side would silently total only a fraction of it. The RPC
      // already groups by top_category, so each of the 5 real root folders
      // shows up as exactly one row — no further folding needed here.
      const { data, error: err } = await supabase.rpc("stock_turnover_by_category", {
        p_stores: warehouseCodes,
        p_from: ymd(r.start),
        p_to: ymd(r.end),
      });
      if (cancelled) return;
      if (err || !data) {
        setTurnoverByBucket([]);
        setTurnoverLoading(false);
        return;
      }
      const byCategory = new Map<
        string,
        { cogs: number; stock_value: number; revenue: number; stock_sale_value: number }
      >(
        (
          data as { category: string; cogs: number; stock_value: number; revenue: number; stock_sale_value: number }[]
        ).map((row) => [row.category, row])
      );
      const buckets = TOP_CATEGORIES.map((b) => {
        const row = byCategory.get(b.key);
        return {
          label: b.label,
          cogs: row?.cogs ?? 0,
          stockValue: row?.stock_value ?? 0,
          revenue: row?.revenue ?? 0,
          stockSaleValue: row?.stock_sale_value ?? 0,
        };
      });
      setTurnoverByBucket(buckets);
      setTurnoverLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStores.join(","), periodIndex, activeCustom?.start, activeCustom?.end]);

  const turnoverStockValueTotal = turnoverByBucket.reduce((acc, r) => acc + r.stockValue, 0);
  const turnoverCogsTotal = turnoverByBucket.reduce((acc, r) => acc + r.cogs, 0);
  const turnoverPct = turnoverStockValueTotal > 0 ? (turnoverCogsTotal / turnoverStockValueTotal) * 100 : null;
  const turnoverRevenueTotal = turnoverByBucket.reduce((acc, r) => acc + r.revenue, 0);
  const turnoverStockSaleValueTotal = turnoverByBucket.reduce((acc, r) => acc + r.stockSaleValue, 0);

  // selectedStores starts empty and updates a moment later once the store
  // list finishes loading, firing a second load() call right behind the
  // first — without this guard, whichever of the two happens to resolve
  // last wins, so the correct (non-empty-filter) result could get clobbered
  // by the earlier call's empty-selection result landing after it.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const { start, end } = activeCustom
        ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
        : getPeriodRange(periodIndex, new Date());
      const { data, error: err } = await supabase
        .from("moysklad_sales_daily")
        .select("sale_date, revenue, receipts_count, items_count, cost, moysklad_registers(store)")
        .gte("sale_date", ymd(start))
        .lte("sale_date", ymd(end));
      if (err) throw err;

      type Row = {
        sale_date: string;
        revenue: number;
        receipts_count: number;
        items_count: number;
        cost: number | null;
        moysklad_registers: { store: string | null } | null;
      };
      const byDate = new Map<string, { revenue: number; receipts: number; items: number; costSum: number; costMissing: boolean }>();
      for (const row of (data ?? []) as unknown as Row[]) {
        const store = row.moysklad_registers?.store ?? null;
        if (store && !selectedStores.includes(store)) continue;
        const agg = byDate.get(row.sale_date) ?? { revenue: 0, receipts: 0, items: 0, costSum: 0, costMissing: false };
        agg.revenue += row.revenue ?? 0;
        agg.receipts += row.receipts_count ?? 0;
        agg.items += row.items_count ?? 0;
        if (row.cost === null) agg.costMissing = true;
        else agg.costSum += row.cost;
        byDate.set(row.sale_date, agg);
      }
      const rows = [...byDate.entries()]
        .map(([date, a]) => ({ date, revenue: a.revenue, receipts: a.receipts, items: a.items, cost: a.costMissing ? null : a.costSum }))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (seq !== loadSeq.current) return; // a newer load() has since started — drop this stale result
      setDayRows(rows);
      setRange({ start, end });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setDayRows([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodIndex, activeCustom?.start, activeCustom?.end, selectedStores.join(",")]);

  useEffect(() => {
    if (!showCustomPicker) return;
    function onClick(e: MouseEvent) {
      if (customPickerRef.current && !customPickerRef.current.contains(e.target as Node)) setShowCustomPicker(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showCustomPicker]);

  function applyCustomRange() {
    if (!customStart || !customEnd || customStart > customEnd) return;
    setActiveCustom({ start: customStart, end: customEnd });
    setShowCustomPicker(false);
  }

  useEffect(() => {
    load();
  }, [load]);

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Обзор».</p>
      </div>
    );
  }

  const today = stripTime(new Date());
  const byDateMap = new Map(dayRows.map((r) => [r.date, r]));
  // Fill every day in the range, even ones with no sales, so the chart's
  // x-axis is an even daily grid instead of skipping gaps.
  const dayCount = Math.round((range.end.getTime() - range.start.getTime()) / 86400000) + 1;
  const points: DayPoint[] = [];
  for (let i = 0; i < dayCount; i++) {
    const d = addDays(range.start, i);
    const date = ymd(d);
    const row = byDateMap.get(date);
    points.push({ date, label: `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`, revenue: row?.revenue ?? 0 });
  }

  const totalRevenue = dayRows.reduce((acc, r) => acc + r.revenue, 0);
  const totalReceipts = dayRows.reduce((acc, r) => acc + r.receipts, 0);
  const totalItems = dayRows.reduce((acc, r) => acc + r.items, 0);
  const costKnown = dayRows.every((r) => r.cost !== null);
  const totalCost = costKnown ? dayRows.reduce((acc, r) => acc + (r.cost ?? 0), 0) : null;
  const avgCheck = totalReceipts > 0 ? totalRevenue / totalReceipts : 0;
  const itemsPerReceipt = totalReceipts > 0 ? totalItems / totalReceipts : 0;
  const margin = totalCost !== null ? totalRevenue - totalCost : null;
  const marginPct = margin !== null && totalRevenue !== 0 ? (margin / totalRevenue) * 100 : null;

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  // Not today.getDate() — МойСклад syncs overnight for the PREVIOUS day, so
  // today's row never exists yet while today is still ongoing (see
  // yesterdayInAlmaty in the sync route). Averaging over today.getDate()
  // would divide by a day that has zero revenue in the data, understating
  // the daily run-rate — on the month's last day this made forecast exactly
  // equal actual (daysElapsed === daysInMonth), erasing the extrapolation
  // entirely. Using only the days actually present in mtdRevenue fixes it.
  const daysElapsed = Math.max(0, today.getDate() - 1);
  const mtdRevenue = dayRows.filter((r) => r.date >= ymd(monthStart)).reduce((acc, r) => acc + r.revenue, 0);
  const forecast = daysElapsed > 0 ? (mtdRevenue / daysElapsed) * daysInMonth : 0;

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Общее</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Обзор</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Сводка по продажам за выбранный период — те же данные из МойСклад, что и на странице
          «Продажа», просто в одном экране.
        </p>
        {error && (
          <div className="flex items-center gap-3 text-sm text-[#A34B36]">
            <span>{error}</span>
            <button type="button" onClick={load} className="font-semibold underline">
              Повторить
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap bg-surface border border-border rounded-card p-1.5 w-fit relative">
        {PERIODS.map((p, i) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setPeriodIndex(i);
              setActiveCustom(null);
            }}
            disabled={loading}
            className={`font-sans text-[13px] rounded-md px-3.5 py-2 disabled:opacity-60 ${
              periodIndex === i && !activeCustom ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {p}
          </button>
        ))}
        <div className="w-px h-5 bg-border mx-0.5" />
        <div ref={customPickerRef} className="relative">
          <button
            type="button"
            onClick={() => {
              if (!showCustomPicker) {
                setCustomStart(activeCustom?.start ?? ymd(addDays(new Date(), -6)));
                setCustomEnd(activeCustom?.end ?? ymd(new Date()));
              }
              setShowCustomPicker((v) => !v);
            }}
            className={`text-[13px] rounded-md px-3.5 py-2 ${
              activeCustom ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {activeCustom ? `${activeCustom.start} — ${activeCustom.end}` : "Свой период"}
          </button>
          {showCustomPicker && (
            <div className="absolute right-0 top-full mt-2 z-50 bg-surface border border-border rounded-lg shadow-lg p-3.5 flex flex-col gap-2.5 w-[230px]">
              <label className="flex flex-col gap-1 text-xs text-muted">
                С
                <input
                  type="date"
                  value={customStart}
                  max={customEnd || undefined}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="border border-border rounded-md px-2 py-1.5 text-[13px] bg-paper text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                По
                <input
                  type="date"
                  value={customEnd}
                  min={customStart || undefined}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="border border-border rounded-md px-2 py-1.5 text-[13px] bg-paper text-ink"
                />
              </label>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCustomPicker(false)}
                  className="text-[12.5px] font-semibold text-muted px-2.5 py-1.5 rounded-md hover:bg-paper"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={applyCustomRange}
                  disabled={!customStart || !customEnd || customStart > customEnd}
                  className="text-[12.5px] font-bold text-paper bg-accent rounded-md px-3 py-1.5 disabled:opacity-50"
                >
                  Применить
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end -mt-2">
        <PdfButton
          disabled={loading || dayRows.length === 0}
          build={(): PdfDoc => {
            const ru = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
            const periodLabel = activeCustom ? "Свой период" : PERIODS[periodIndex];
            const sections: PdfDoc["sections"] = [
              {
                title: "Продажи по дням",
                headers: ["Дата", "Выручка", "Чеков", "Штук", "Средний чек", "Валовая прибыль"],
                widths: [1.2, 1.6, 1, 1, 1.4, 1.6],
                rows: [...dayRows]
                  .sort((a, b) => (a.date < b.date ? -1 : 1))
                  .map((r) => {
                    const [y, m, d] = r.date.split("-");
                    return [
                      `${d}.${m}.${y}`,
                      money(r.revenue),
                      r.receipts,
                      r.items,
                      r.receipts > 0 ? money(r.revenue / r.receipts) : "—",
                      r.cost !== null ? money(r.revenue - r.cost) : "—",
                    ];
                  })
                  .concat([
                    [
                      "Итого",
                      money(totalRevenue),
                      totalReceipts,
                      totalItems,
                      totalReceipts > 0 ? money(avgCheck) : "—",
                      margin !== null ? money(margin) : "—",
                    ],
                  ]),
                rowKinds: [...dayRows.map(() => "normal" as const), "total" as const],
              },
            ];
            if (turnoverByBucket.length > 0) {
              const body: (string | number)[][] = turnoverByBucket.map((r) => [
                r.label,
                money(r.cogs),
                money(r.stockValue),
                r.stockValue > 0 ? `${((r.cogs / r.stockValue) * 100).toFixed(0)}%` : "—",
              ]);
              body.push(["Итого", money(turnoverCogsTotal), money(turnoverStockValueTotal), turnoverPct !== null ? `${turnoverPct.toFixed(0)}%` : "—"]);
              sections.push({
                title: "Оборачиваемость по категориям",
                note: "Себестоимость продаж за период / себестоимость текущего остатка.",
                headers: ["Категория", "Себестоимость продаж", "Себестоимость остатка", "Оборачиваемость"],
                widths: [2, 1.6, 1.6, 1.4],
                rows: body,
                rowKinds: body.map((_, i) => (i === body.length - 1 ? "total" : "normal")),
              });
            }
            return {
              fileName: `Обзор_${ymd(range.start)}_${ymd(range.end)}`,
              title: "Обзор продаж",
              subtitle: `${periodLabel}: ${ru(range.start)} — ${ru(range.end)}`,
              kpis: [
                { label: "Выручка", value: money(totalRevenue) },
                { label: "Чеков", value: totalReceipts.toLocaleString("ru-RU") },
                { label: "Средний чек", value: totalReceipts > 0 ? money(avgCheck) : "—" },
                { label: "Глубина чека", value: totalReceipts > 0 ? `${itemsPerReceipt.toFixed(1)} шт` : "—" },
                { label: "Валовая прибыль", value: margin !== null ? money(margin) : "—", note: marginPct !== null ? `${marginPct.toFixed(0)}% от выручки` : undefined },
                { label: "Оборачиваемость склада", value: turnoverPct !== null ? `${turnoverPct.toFixed(0)}%` : "—" },
              ],
              sections,
            };
          }}
        />
      </div>

      <SalesPlanWindow stores={selectedStores} range={planRange} />

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <Kpi label="Выручка" value={money(totalRevenue)} />
            <Kpi label="Чеков" value={totalReceipts.toLocaleString("ru-RU")} />
            <Kpi label="Средний чек" value={money(avgCheck)} />
            <Kpi label="Глубина чека" value={itemsPerReceipt.toFixed(2)} />
            <Kpi
              label="Валовая прибыль"
              value={margin !== null ? money(margin) : "—"}
              suffix={
                marginPct !== null && (
                  <span className="self-start text-[11px] font-bold text-accent bg-[#DDEBD9] rounded-full px-2 py-0.5">
                    {marginPct >= 0 ? "↑" : "↓"} {Math.abs(marginPct).toFixed(0)}%
                  </span>
                )
              }
            />
            <Kpi
              label="Оборачиваемость склада"
              value={turnoverLoading ? "…" : turnoverPct !== null ? `${turnoverPct.toFixed(1)}%` : "—"}
              suffix={<span className="text-[11px] text-mutedLight">себест. продаж / себест. остатка</span>}
            />
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">Выручка, ₸</div>
            <RevenueChart points={points} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-1.5">
              <div className="text-xs text-muted">
                С 1.{pad2(today.getMonth() + 1)}. по {today.getDate()}-е
              </div>
              <div className="font-serif text-[26px] font-semibold num">{money(mtdRevenue)}</div>
            </div>
            <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-1.5">
              <div className="text-xs text-muted">Прогноз месяца</div>
              <div className="font-serif text-[26px] font-semibold num">{money(forecast)}</div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
              <div className="text-[15px] font-bold">Оборачиваемость по категориям</div>
              <div className="text-xs text-mutedLight">себест. продаж за период / себест. текущего остатка</div>
            </div>
            {turnoverLoading ? (
              <div className="text-sm text-muted py-2">Загрузка…</div>
            ) : turnoverByBucket.length === 0 ? (
              <div className="text-sm text-muted py-2">Нет данных по остаткам за выбранные точки.</div>
            ) : (
              <>
                {/* Mobile: stacked cards, no horizontal scroll anywhere — the
                    4-column grid below just doesn't fit a phone width. */}
                <div className="flex flex-col gap-2 sm:hidden">
                  {turnoverByBucket.map((r) => {
                    const pct = r.stockValue > 0 ? (r.cogs / r.stockValue) * 100 : null;
                    return (
                      <div key={r.label} className="rounded-lg border border-borderSoft p-3 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <div className="font-semibold text-[13px]">{r.label}</div>
                          <div className="font-bold num text-[13px]">{pct !== null ? `${pct.toFixed(1)}%` : "—"}</div>
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-muted">
                          <span>Продано (себест.)</span>
                          <span className="num">{money(r.cogs)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-muted">
                          <span>Остаток (себест.)</span>
                          <span className="num">{money(r.stockValue)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-muted">
                          <span>Продано (прод. цена)</span>
                          <span className="num">{money(r.revenue)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-muted">
                          <span>Остаток (прод. цена)</span>
                          <span className="num">{money(r.stockSaleValue)}</span>
                        </div>
                      </div>
                    );
                  })}
                  <div className="rounded-lg border border-border p-3 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-[13px] font-bold">
                      <span>Итого</span>
                      <span className="num">{turnoverPct !== null ? `${turnoverPct.toFixed(1)}%` : "—"}</span>
                    </div>
                    <div className="flex items-center justify-between text-[12px]">
                      <span>Продано (себест.)</span>
                      <span className="num">{money(turnoverCogsTotal)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[12px]">
                      <span>Остаток (себест.)</span>
                      <span className="num">{money(turnoverStockValueTotal)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[12px]">
                      <span>Продано (прод. цена)</span>
                      <span className="num">{money(turnoverRevenueTotal)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[12px]">
                      <span>Остаток (прод. цена)</span>
                      <span className="num">{money(turnoverStockSaleValueTotal)}</span>
                    </div>
                  </div>
                </div>

                {/* Desktop/tablet: table — plenty of width, no scroll needed. Each
                    money cell shows себестоимость as the primary number and
                    продажная цена as a smaller line right under it, so the
                    extra figures sit "рядом" without widening the table. */}
                <div className="hidden sm:flex sm:flex-col">
                  <div className="grid grid-cols-[1fr_90px_130px_130px] gap-3 text-xs text-mutedLight pb-2 border-b border-borderSoft">
                    <div>Категория</div>
                    <div className="text-right">Оборачив.</div>
                    <div className="text-right">Продано, ₸ (себест. / прод.)</div>
                    <div className="text-right">Остаток, ₸ (себест. / прод.)</div>
                  </div>
                  {turnoverByBucket.map((r) => {
                    const pct = r.stockValue > 0 ? (r.cogs / r.stockValue) * 100 : null;
                    return (
                      <div
                        key={r.label}
                        className="grid grid-cols-[1fr_90px_130px_130px] gap-3 text-[13px] py-2 border-b border-borderSoft last:border-b-0"
                      >
                        <div className="font-semibold truncate self-center">{r.label}</div>
                        <div className="text-right num self-center">{pct !== null ? `${pct.toFixed(1)}%` : "—"}</div>
                        <div className="text-right">
                          <div className="num text-muted">{money(r.cogs)}</div>
                          <div className="num text-[11px] text-mutedLight">{money(r.revenue)}</div>
                        </div>
                        <div className="text-right">
                          <div className="num text-muted">{money(r.stockValue)}</div>
                          <div className="num text-[11px] text-mutedLight">{money(r.stockSaleValue)}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div className="grid grid-cols-[1fr_90px_130px_130px] gap-3 text-[13px] font-bold pt-2.5 mt-1 border-t border-border">
                    <div className="self-center">Итого</div>
                    <div className="text-right num self-center">{turnoverPct !== null ? `${turnoverPct.toFixed(1)}%` : "—"}</div>
                    <div className="text-right">
                      <div className="num">{money(turnoverCogsTotal)}</div>
                      <div className="num text-[11px] font-normal text-mutedLight">{money(turnoverRevenueTotal)}</div>
                    </div>
                    <div className="text-right">
                      <div className="num">{money(turnoverStockValueTotal)}</div>
                      <div className="num text-[11px] font-normal text-mutedLight">{money(turnoverStockSaleValueTotal)}</div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
