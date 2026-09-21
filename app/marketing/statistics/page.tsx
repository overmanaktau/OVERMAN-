"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import KpiCard from "@/components/KpiCard";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

const PERIODS = ["Прошлая неделя", "Эта неделя", "С начала месяца", "30 дней", "Всё время"];
const DEFAULT_PERIOD = 2; // "С начала месяца"

const CHANNEL_DEFS = [
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
  { key: "instagram_public", label: "Instagram паблик" },
  { key: "flyer", label: "Раздача флаеров" },
  { key: "two_gis", label: "2ГИС карта" },
] as const;

const CHANNEL_COLORS = ["bg-[#17140F]", "bg-accent", "bg-[#6B7A5E]", "bg-[#A89A78]", "bg-[#C9BFA5]"];

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]; // matches Date#getDay()

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

type Range = { start: Date; end: Date; prevStart: Date; prevEnd: Date; hasPrev: boolean };

function getPeriodRange(index: number, today: Date): Range {
  const d = stripTime(today);
  const dow = d.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = addDays(d, mondayOffset);
  const thisSunday = addDays(thisMonday, 6);

  if (index === 0) {
    const start = addDays(thisMonday, -7);
    const end = addDays(thisSunday, -7);
    return { start, end, prevStart: addDays(start, -7), prevEnd: addDays(end, -7), hasPrev: true };
  }
  if (index === 1) {
    const start = thisMonday;
    const end = thisSunday;
    return { start, end, prevStart: addDays(start, -7), prevEnd: addDays(end, -7), hasPrev: true };
  }
  if (index === 2) {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = d;
    const daysSoFar = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -(daysSoFar - 1));
    return { start, end, prevStart, prevEnd, hasPrev: true };
  }
  if (index === 3) {
    const start = addDays(d, -29);
    const end = d;
    const prevEnd = addDays(start, -1);
    return { start, end, prevStart: addDays(prevEnd, -29), prevEnd, hasPrev: true };
  }
  // "Всё время"
  return { start: new Date(2000, 0, 1), end: d, prevStart: d, prevEnd: d, hasPrev: false };
}

function parseYmd(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

function getCustomRange(startStr: string, endStr: string): Range {
  const start = parseYmd(startStr);
  const end = parseYmd(endStr);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return { start, end, prevStart, prevEnd, hasPrev: true };
}

type TrafficRow = {
  entry_date: string;
  traffic_plan: number | null;
  traffic_fact: number | null;
  instagram: number | null;
  tiktok: number | null;
  instagram_public: number | null;
  flyer: number | null;
  two_gis: number | null;
};

function sumTraffic(rows: TrafficRow[]) {
  const totals = { plan: 0, fact: 0, instagram: 0, tiktok: 0, instagram_public: 0, flyer: 0, two_gis: 0 };
  for (const r of rows) {
    totals.plan += r.traffic_plan ?? 0;
    totals.fact += r.traffic_fact ?? 0;
    totals.instagram += r.instagram ?? 0;
    totals.tiktok += r.tiktok ?? 0;
    totals.instagram_public += r.instagram_public ?? 0;
    totals.flyer += r.flyer ?? 0;
    totals.two_gis += r.two_gis ?? 0;
  }
  return totals;
}

function pctChange(curr: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((curr - prev) / prev) * 100;
}

function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}

export default function StatisticsPage() {
  const { isAdmin, permissions } = useAuth();
  const { selected: selectedStores } = useStoreSelection();

  const [periodIndex, setPeriodIndex] = useState(DEFAULT_PERIOD);
  const [activeCustom, setActiveCustom] = useState<{ start: string; end: string } | null>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customPickerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [current, setCurrent] = useState<TrafficRow[]>([]);
  const [previous, setPrevious] = useState<TrafficRow[]>([]);
  const [expensesTotal, setExpensesTotal] = useState(0);
  const [prevExpensesTotal, setPrevExpensesTotal] = useState(0);
  const [range, setRange] = useState<Range | null>(null);
  const [salesTotals, setSalesTotals] = useState({ revenue: 0, receipts: 0 });
  const [prevSalesTotals, setPrevSalesTotals] = useState({ revenue: 0, receipts: 0 });

  const canView = isAdmin || permissions["marketing.statistics"].canView;

  const load = useCallback(async () => {
    if (selectedStores.length === 0) {
      setCurrent([]);
      setPrevious([]);
      setExpensesTotal(0);
      setPrevExpensesTotal(0);
      setSalesTotals({ revenue: 0, receipts: 0 });
      setPrevSalesTotals({ revenue: 0, receipts: 0 });
      setRange(activeCustom ? getCustomRange(activeCustom.start, activeCustom.end) : getPeriodRange(periodIndex, new Date()));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = activeCustom ? getCustomRange(activeCustom.start, activeCustom.end) : getPeriodRange(periodIndex, new Date());
      setRange(r);

      const { data: registers, error: registersError } = await supabase
        .from("moysklad_registers")
        .select("id, store");
      if (registersError) throw registersError;
      const registerIds = (registers ?? [])
        .filter((reg) => selectedStores.includes(reg.store))
        .map((reg) => reg.id);

      function salesQuery(from: string, to: string) {
        return registerIds.length > 0
          ? supabase
              .from("moysklad_sales_daily")
              .select("revenue, receipts_count")
              .in("register_id", registerIds)
              .gte("sale_date", from)
              .lte("sale_date", to)
          : Promise.resolve({ data: [], error: null });
      }

      function sumSales(rows: { revenue: number; receipts_count: number }[]) {
        return rows.reduce(
          (acc, row) => ({ revenue: acc.revenue + row.revenue, receipts: acc.receipts + row.receipts_count }),
          { revenue: 0, receipts: 0 }
        );
      }

      const queries = [
        supabase
          .from("traffic_entries")
          .select("entry_date, traffic_plan, traffic_fact, instagram, tiktok, instagram_public, flyer, two_gis")
          .in("store", selectedStores)
          .gte("entry_date", ymd(r.start))
          .lte("entry_date", ymd(r.end)),
        supabase.from("extra_expenses").select("amount").gte("expense_date", ymd(r.start)).lte("expense_date", ymd(r.end)),
        salesQuery(ymd(r.start), ymd(r.end)),
      ] as const;

      if (r.hasPrev) {
        const prevQueries = [
          supabase
            .from("traffic_entries")
            .select("entry_date, traffic_plan, traffic_fact, instagram, tiktok, instagram_public, flyer, two_gis")
            .in("store", selectedStores)
            .gte("entry_date", ymd(r.prevStart))
            .lte("entry_date", ymd(r.prevEnd)),
          supabase.from("extra_expenses").select("amount").gte("expense_date", ymd(r.prevStart)).lte("expense_date", ymd(r.prevEnd)),
          salesQuery(ymd(r.prevStart), ymd(r.prevEnd)),
        ] as const;

        const [entriesRes, expensesRes, salesRes, prevEntriesRes, prevExpensesRes, prevSalesRes] = await Promise.all([
          ...queries,
          ...prevQueries,
        ]);

        const firstError =
          entriesRes.error || expensesRes.error || salesRes.error || prevEntriesRes.error || prevExpensesRes.error || prevSalesRes.error;
        if (firstError) throw firstError;

        setCurrent(entriesRes.data ?? []);
        setExpensesTotal((expensesRes.data ?? []).reduce((acc, e) => acc + (e.amount ?? 0), 0));
        setSalesTotals(sumSales(salesRes.data ?? []));
        setPrevious(prevEntriesRes.data ?? []);
        setPrevExpensesTotal((prevExpensesRes.data ?? []).reduce((acc, e) => acc + (e.amount ?? 0), 0));
        setPrevSalesTotals(sumSales(prevSalesRes.data ?? []));
      } else {
        const [entriesRes, expensesRes, salesRes] = await Promise.all(queries);
        const firstError = entriesRes.error || expensesRes.error || salesRes.error;
        if (firstError) throw firstError;

        setCurrent(entriesRes.data ?? []);
        setExpensesTotal((expensesRes.data ?? []).reduce((acc, e) => acc + (e.amount ?? 0), 0));
        setSalesTotals(sumSales(salesRes.data ?? []));
        setPrevious([]);
        setPrevExpensesTotal(0);
        setPrevSalesTotals({ revenue: 0, receipts: 0 });
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodIndex, activeCustom?.start, activeCustom?.end, selectedStores.join(",")]);

  useEffect(() => {
    load();
  }, [load]);

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

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Статистика».</p>
      </div>
    );
  }

  const totals = sumTraffic(current);
  const prevTotals = sumTraffic(previous);

  const channelTotal =
    totals.instagram + totals.tiktok + totals.instagram_public + totals.flyer + totals.two_gis;
  const totalSpend = channelTotal + expensesTotal;

  const prevChannelTotal =
    prevTotals.instagram + prevTotals.tiktok + prevTotals.instagram_public + prevTotals.flyer + prevTotals.two_gis;
  const prevTotalSpend = prevChannelTotal + prevExpensesTotal;

  const costPerVisitor = totals.fact > 0 ? totalSpend / totals.fact : null;
  const prevCostPerVisitor = prevTotals.fact > 0 ? prevTotalSpend / prevTotals.fact : null;

  const spendChange = pctChange(totalSpend, prevTotalSpend);
  const costChange =
    costPerVisitor !== null && prevCostPerVisitor !== null ? pctChange(costPerVisitor, prevCostPerVisitor) : null;
  const expensesChange = pctChange(expensesTotal, prevExpensesTotal);

  // "Покупатель" = чек в МойСклад (receipts_count), в отличие от "посетителя"
  // (traffic_fact) — не каждый посетитель делает покупку.
  const avgCheck = salesTotals.receipts > 0 ? salesTotals.revenue / salesTotals.receipts : null;
  const prevAvgCheck = prevSalesTotals.receipts > 0 ? prevSalesTotals.revenue / prevSalesTotals.receipts : null;

  const costPerBuyer = salesTotals.receipts > 0 ? totalSpend / salesTotals.receipts : null;
  const prevCostPerBuyer = prevSalesTotals.receipts > 0 ? prevTotalSpend / prevSalesTotals.receipts : null;
  const costPerBuyerChange =
    costPerBuyer !== null && prevCostPerBuyer !== null ? pctChange(costPerBuyer, prevCostPerBuyer) : null;

  // Конверсия посетителей в покупателей: чек / посетитель × 100.
  const conversionPct = totals.fact > 0 ? (salesTotals.receipts / totals.fact) * 100 : null;

  const spendVsCheckPct = costPerBuyer !== null && avgCheck !== null && avgCheck > 0 ? (costPerBuyer / avgCheck) * 100 : null;
  const prevSpendVsCheckPct =
    prevCostPerBuyer !== null && prevAvgCheck !== null && prevAvgCheck > 0 ? (prevCostPerBuyer / prevAvgCheck) * 100 : null;
  const spendVsCheckChange =
    spendVsCheckPct !== null && prevSpendVsCheckPct !== null ? pctChange(spendVsCheckPct, prevSpendVsCheckPct) : null;

  const channels = CHANNEL_DEFS.map((c) => ({ ...c, amount: totals[c.key] }))
    .sort((a, b) => b.amount - a.amount)
    .map((c, i) => ({
      ...c,
      pct: channelTotal > 0 ? Math.round((c.amount / channelTotal) * 100) : 0,
      color: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
    }));

  // Chart shows at most the last 31 days of the selected range so the bars stay readable.
  const chartStart =
    range && range.end.getTime() - range.start.getTime() > 30 * 86400000 ? addDays(range.end, -30) : range?.start;
  const chartDays: { date: string; label: string; plan: number; fact: number }[] = [];
  if (range && chartStart) {
    const byDate = new Map(current.map((r) => [r.entry_date, r]));
    const totalDays = Math.round((range.end.getTime() - chartStart.getTime()) / 86400000) + 1;
    const useWeekdayLabels = totalDays <= 7;
    for (let cursor = new Date(chartStart); cursor <= range.end; cursor = addDays(cursor, 1)) {
      const key = ymd(cursor);
      const row = byDate.get(key);
      chartDays.push({
        date: key,
        label: useWeekdayLabels ? WEEKDAYS[cursor.getDay()] : String(cursor.getDate()),
        plan: row?.traffic_plan ?? 0,
        fact: row?.traffic_fact ?? 0,
      });
    }
  }
  const maxChartValue = Math.max(1, ...chartDays.flatMap((d) => [d.plan, d.fact]));

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Маркетинг</div>
        <div className="flex items-center gap-2.5">
          <h1 className="font-serif text-[28px] font-semibold m-0">Статистика</h1>
        </div>
        {error && (
          <div className="flex items-center gap-3 text-sm text-[#A34B36]">
            <span>{error}</span>
            <button type="button" onClick={load} className="font-semibold underline">
              Повторить
            </button>
          </div>
        )}
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit relative">
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
              i === periodIndex && !activeCustom ? "bg-accent text-paper font-bold" : "text-muted font-medium"
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
            disabled={loading}
            className={`text-[13px] rounded-md px-3.5 py-2 disabled:opacity-60 ${
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

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-3.5">
        <KpiCard
          label="Выполнение плана по трафику"
          value={totals.plan > 0 ? `${Math.round((totals.fact / totals.plan) * 100)}%` : "—"}
          note={
            totals.plan > 0
              ? `${totals.fact.toLocaleString("ru-RU")} из ${totals.plan.toLocaleString("ru-RU")} план`
              : "нет данных за период"
          }
        />
        <KpiCard
          label="Общий расход на маркетинг"
          value={money(totalSpend)}
          note={spendChange !== null ? `${spendChange >= 0 ? "▲" : "▼"} ${Math.abs(spendChange).toFixed(0)}% к пред. периоду` : undefined}
          noteTone={spendChange !== null ? (spendChange >= 0 ? "positive" : "negative") : "neutral"}
        />
        <KpiCard
          label="Доп. расходы"
          value={money(expensesTotal)}
          note={expensesChange !== null ? `${expensesChange >= 0 ? "▲" : "▼"} ${Math.abs(expensesChange).toFixed(0)}% к пред. периоду` : undefined}
          noteTone={expensesChange !== null ? (expensesChange >= 0 ? "positive" : "negative") : "neutral"}
        />
        <KpiCard
          label="Цена одного посетителя"
          value={costPerVisitor !== null ? money(costPerVisitor) : "—"}
          note={costChange !== null ? `${costChange >= 0 ? "▲" : "▼"} ${Math.abs(costChange).toFixed(0)}% к пред. периоду` : undefined}
          noteTone={costChange !== null ? (costChange >= 0 ? "positive" : "negative") : "neutral"}
        />
        <KpiCard
          label="Цена одного покупателя"
          value={costPerBuyer !== null ? money(costPerBuyer) : "—"}
          valueSuffix={conversionPct !== null ? `(${conversionPct.toFixed(1)}%)` : undefined}
          note={
            costPerBuyerChange !== null
              ? `${costPerBuyerChange >= 0 ? "▲" : "▼"} ${Math.abs(costPerBuyerChange).toFixed(0)}% к пред. периоду`
              : "нет данных МойСклад за период"
          }
          noteTone={costPerBuyerChange !== null ? (costPerBuyerChange >= 0 ? "positive" : "negative") : "neutral"}
        />
        <KpiCard
          label="Маркетинг, % от среднего чека"
          value={spendVsCheckPct !== null ? `${spendVsCheckPct.toFixed(1)}%` : "—"}
          note={
            spendVsCheckChange !== null
              ? `${spendVsCheckChange >= 0 ? "▲" : "▼"} ${Math.abs(spendVsCheckChange).toFixed(0)}% к пред. периоду`
              : "нет данных МойСклад за период"
          }
          noteTone={spendVsCheckChange !== null ? (spendVsCheckChange >= 0 ? "positive" : "negative") : "neutral"}
        />
      </div>

      {/* Traffic chart + channel spend */}
      <div className="grid grid-cols-[1.35fr_1fr] gap-4 items-stretch">
        <div className="bg-surface border border-border rounded-card px-6 pt-[22px] pb-[18px] flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-bold">Трафик: план / факт</div>
            <div className="flex items-center gap-4 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#D8D2C4] inline-block" /> План
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-accent inline-block" /> Факт
              </span>
            </div>
          </div>
          {chartDays.length === 0 ? (
            <div className="text-sm text-muted py-8 text-center">Нет данных за период</div>
          ) : (
            <div className="flex items-end gap-1.5 h-[170px] px-1">
              {chartDays.map((d) => (
                <div key={d.date} className="flex flex-col items-center gap-2 h-full justify-end flex-1 min-w-0">
                  <div className="flex items-end gap-0.5 h-[130px] w-full justify-center">
                    <div
                      className="w-full max-w-[14px] bg-[#D8D2C4] rounded-t-sm"
                      style={{ height: `${(d.plan / maxChartValue) * 130}px` }}
                    />
                    <div
                      className="w-full max-w-[14px] bg-accent rounded-t-sm"
                      style={{ height: `${(d.fact / maxChartValue) * 130}px` }}
                    />
                  </div>
                  <div className="text-[10px] text-mutedLight">{d.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
          <div className="text-[15px] font-bold">Расходы по каналам</div>
          {channelTotal === 0 ? (
            <div className="text-sm text-muted py-4">Нет расходов за период</div>
          ) : (
            <div className="flex flex-col gap-3.5">
              {channels.map((c) => (
                <div key={c.key} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="font-semibold">{c.label}</span>
                    <span className="text-muted num">
                      {money(c.amount)} · {c.pct}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-borderSoft rounded-full overflow-hidden">
                    <div className={`h-full ${c.color}`} style={{ width: `${c.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-2.5 border-t border-borderSoft text-[13px] font-bold">
            <span>Итого</span>
            <span className="num">{money(channelTotal)}</span>
          </div>
        </div>
      </div>
    </>
  );
}
