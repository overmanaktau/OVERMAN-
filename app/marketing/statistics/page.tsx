"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [current, setCurrent] = useState<TrafficRow[]>([]);
  const [previous, setPrevious] = useState<TrafficRow[]>([]);
  const [expensesTotal, setExpensesTotal] = useState(0);
  const [prevExpensesTotal, setPrevExpensesTotal] = useState(0);
  const [range, setRange] = useState<Range | null>(null);

  const canView = isAdmin || permissions["marketing.statistics"].canView;

  const load = useCallback(async () => {
    if (selectedStores.length === 0) {
      setCurrent([]);
      setPrevious([]);
      setExpensesTotal(0);
      setPrevExpensesTotal(0);
      setRange(getPeriodRange(periodIndex, new Date()));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = getPeriodRange(periodIndex, new Date());
      setRange(r);

      const queries = [
        supabase
          .from("traffic_entries")
          .select("entry_date, traffic_plan, traffic_fact, instagram, tiktok, instagram_public, flyer, two_gis")
          .in("store", selectedStores)
          .gte("entry_date", ymd(r.start))
          .lte("entry_date", ymd(r.end)),
        supabase.from("extra_expenses").select("amount").gte("expense_date", ymd(r.start)).lte("expense_date", ymd(r.end)),
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
        ] as const;

        const [entriesRes, expensesRes, prevEntriesRes, prevExpensesRes] = await Promise.all([
          ...queries,
          ...prevQueries,
        ]);

        const firstError =
          entriesRes.error || expensesRes.error || prevEntriesRes.error || prevExpensesRes.error;
        if (firstError) throw firstError;

        setCurrent(entriesRes.data ?? []);
        setExpensesTotal((expensesRes.data ?? []).reduce((acc, e) => acc + (e.amount ?? 0), 0));
        setPrevious(prevEntriesRes.data ?? []);
        setPrevExpensesTotal((prevExpensesRes.data ?? []).reduce((acc, e) => acc + (e.amount ?? 0), 0));
      } else {
        const [entriesRes, expensesRes] = await Promise.all(queries);
        const firstError = entriesRes.error || expensesRes.error;
        if (firstError) throw firstError;

        setCurrent(entriesRes.data ?? []);
        setExpensesTotal((expensesRes.data ?? []).reduce((acc, e) => acc + (e.amount ?? 0), 0));
        setPrevious([]);
        setPrevExpensesTotal(0);
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodIndex, selectedStores.join(",")]);

  useEffect(() => {
    load();
  }, [load]);

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
      <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit">
        {PERIODS.map((p, i) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriodIndex(i)}
            disabled={loading}
            className={`font-sans text-[13px] rounded-md px-3.5 py-2 disabled:opacity-60 ${
              i === periodIndex ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {p}
          </button>
        ))}
        <div className="w-px h-5 bg-border mx-0.5" />
        <button type="button" disabled title="Скоро" className="text-[13px] text-mutedLight font-medium px-3.5 py-2">
          Свой период
        </button>
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
        <KpiCard label="Цена одного покупателя" value="Скоро" note="Нужен МойСклад (Этап 3)" />
        <KpiCard label="Маркетинг, % от среднего чека" value="Скоро" note="Нужен МойСклад (Этап 3)" />
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
