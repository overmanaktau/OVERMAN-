"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

const WINDOW_DAYS = 90;

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

export default function ObzorPage() {
  const { isAdmin, permissions } = useAuth();
  const { selected: selectedStores } = useStoreSelection();
  const canView = isAdmin || permissions["marketing.statistics"].canView;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dayRows, setDayRows] = useState<{ date: string; revenue: number; receipts: number; items: number; cost: number | null }[]>([]);

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
      const today = stripTime(new Date());
      const start = addDays(today, -(WINDOW_DAYS - 1));
      const { data, error: err } = await supabase
        .from("moysklad_sales_daily")
        .select("sale_date, revenue, receipts_count, items_count, cost, moysklad_registers(store)")
        .gte("sale_date", ymd(start))
        .lte("sale_date", ymd(today));
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
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setDayRows([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStores.join(",")]);

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
  // Fill every day in the window, even ones with no sales, so the chart's
  // x-axis is an even daily grid instead of skipping gaps.
  const points: DayPoint[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i);
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
  const daysElapsed = today.getDate();
  const mtdRevenue = dayRows.filter((r) => r.date >= ymd(monthStart)).reduce((acc, r) => acc + r.revenue, 0);
  const forecast = daysElapsed > 0 ? (mtdRevenue / daysElapsed) * daysInMonth : 0;

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Общее</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Обзор</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Сводка по продажам за последние {WINDOW_DAYS} дней — те же данные из МойСклад, что и на
          странице «Продажа», просто в одном экране.
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

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <Kpi label="Выручка" value={money(totalRevenue)} />
            <Kpi label="Чеков" value={totalReceipts.toLocaleString("ru-RU")} />
            <Kpi label="Средний чек" value={money(avgCheck)} />
            <Kpi label="Вещей в чеке" value={itemsPerReceipt.toFixed(2)} />
            <Kpi
              label="Маржа"
              value={margin !== null ? money(margin) : "—"}
              suffix={
                marginPct !== null && (
                  <span className="self-start text-[11px] font-bold text-accent bg-[#DDEBD9] rounded-full px-2 py-0.5">
                    {marginPct >= 0 ? "↑" : "↓"} {Math.abs(marginPct).toFixed(0)}%
                  </span>
                )
              }
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
        </>
      )}
    </>
  );
}
