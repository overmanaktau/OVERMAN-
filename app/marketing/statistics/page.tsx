"use client";

import { trim2, trim2Ru } from "@/lib/numFormat";
import { useCallback, useEffect, useRef, useState } from "react";
import KpiCard from "@/components/KpiCard";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { downloadExcel } from "@/lib/exportExcel";
import PdfButton from "@/components/PdfButton";
import type { PdfDoc, PdfTone } from "@/lib/downloadPdf";
import { ruPeriod } from "@/lib/fileNames";

const PERIODS = ["Вчера", "Прошлая неделя", "Эта неделя", "С начала месяца", "Прошлый месяц", "Всё время"];
const DEFAULT_PERIOD = 3; // "С начала месяца"

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
    // Вчера
    const start = addDays(d, -1);
    const end = addDays(d, -1);
    return { start, end, prevStart: addDays(d, -2), prevEnd: addDays(d, -2), hasPrev: true };
  }
  if (index === 1) {
    const start = addDays(thisMonday, -7);
    const end = addDays(thisSunday, -7);
    return { start, end, prevStart: addDays(start, -7), prevEnd: addDays(end, -7), hasPrev: true };
  }
  if (index === 2) {
    const start = thisMonday;
    const end = thisSunday;
    return { start, end, prevStart: addDays(start, -7), prevEnd: addDays(end, -7), hasPrev: true };
  }
  if (index === 3) {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = d;
    const daysSoFar = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -(daysSoFar - 1));
    return { start, end, prevStart, prevEnd, hasPrev: true };
  }
  if (index === 4) {
    // Прошлый месяц
    const start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const end = new Date(d.getFullYear(), d.getMonth(), 0);
    const prevStart = new Date(d.getFullYear(), d.getMonth() - 2, 1);
    const prevEnd = new Date(d.getFullYear(), d.getMonth() - 1, 0);
    return { start, end, prevStart, prevEnd, hasPrev: true };
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

// Посетители и остальные числа статистики: целое — без дробной части, иначе два знака после запятой (lib/numFormat.ts)
const trafficText = trim2Ru;
function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}


function spendVsCheckTone(pct: number): "positive" | "warning" | "negative" {
  if (pct <= 8) return "positive";
  if (pct <= 9) return "warning";
  return "negative";
}

function costPerVisitorTone(value: number): "positive" | "warning" | "negative" {
  if (value <= 500) return "positive";
  if (value <= 600) return "warning";
  return "negative";
}

function planCompletionTone(pct: number): "positive" | "warning" | "negative" {
  if (pct >= 100) return "positive";
  if (pct >= 90) return "warning";
  return "negative";
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
  const [salesByDate, setSalesByDate] = useState<Map<string, { revenue: number; receipts: number }>>(new Map());

  const canView = isAdmin || permissions["marketing.statistics"].canView;

  const load = useCallback(async () => {
    if (selectedStores.length === 0) {
      setCurrent([]);
      setPrevious([]);
      setExpensesTotal(0);
      setPrevExpensesTotal(0);
      setSalesTotals({ revenue: 0, receipts: 0 });
      setPrevSalesTotals({ revenue: 0, receipts: 0 });
      setSalesByDate(new Map());
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

      // МойСклад данные за сегодня всегда неполные (продажи ещё идут), поэтому
      // в статистику никогда не попадает текущий день — только по вчера включительно.
      const yesterdayStr = ymd(addDays(stripTime(new Date()), -1));

      function salesQuery(from: string, to: string) {
        const cappedTo = to > yesterdayStr ? yesterdayStr : to;
        return registerIds.length > 0 && from <= cappedTo
          ? supabase
              .from("moysklad_sales_daily")
              .select("sale_date, revenue, receipts_count")
              .in("register_id", registerIds)
              .gte("sale_date", from)
              .lte("sale_date", cappedTo)
          : Promise.resolve({ data: [], error: null });
      }

      function sumSales(rows: { revenue: number; receipts_count: number }[]) {
        return rows.reduce(
          (acc, row) => ({ revenue: acc.revenue + row.revenue, receipts: acc.receipts + row.receipts_count }),
          { revenue: 0, receipts: 0 }
        );
      }

      // Same rows sumSales totals, but kept per-day (dates can repeat across
      // registers, hence the accumulate-into-Map instead of a plain group-by)
      // for the per-day Excel export below.
      function groupSalesByDate(rows: { sale_date: string; revenue: number; receipts_count: number }[]) {
        const map = new Map<string, { revenue: number; receipts: number }>();
        for (const row of rows) {
          const prev = map.get(row.sale_date) ?? { revenue: 0, receipts: 0 };
          map.set(row.sale_date, { revenue: prev.revenue + row.revenue, receipts: prev.receipts + row.receipts_count });
        }
        return map;
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
        setSalesByDate(groupSalesByDate(salesRes.data ?? []));
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
        setSalesByDate(groupSalesByDate(salesRes.data ?? []));
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

  const planCompletionPct = totals.plan > 0 ? (totals.fact / totals.plan) * 100 : null;
  const prevPlanCompletionPct = prevTotals.plan > 0 ? (prevTotals.fact / prevTotals.plan) * 100 : null;
  const planCompletionChange =
    planCompletionPct !== null && prevPlanCompletionPct !== null
      ? pctChange(planCompletionPct, prevPlanCompletionPct)
      : null;
  const trafficShortfall = Math.max(0, totals.plan - totals.fact);

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

  // Только расходы по каналам — без доп. расходов, в отличие от «Цена
  // одного покупателя», которая считает весь маркетинговый расход.
  const channelCostPerBuyer = salesTotals.receipts > 0 ? channelTotal / salesTotals.receipts : null;
  const prevChannelCostPerBuyer = prevSalesTotals.receipts > 0 ? prevChannelTotal / prevSalesTotals.receipts : null;

  const spendVsCheckPct =
    channelCostPerBuyer !== null && avgCheck !== null && avgCheck > 0 ? (channelCostPerBuyer / avgCheck) * 100 : null;
  const prevSpendVsCheckPct =
    prevChannelCostPerBuyer !== null && prevAvgCheck !== null && prevAvgCheck > 0
      ? (prevChannelCostPerBuyer / prevAvgCheck) * 100
      : null;
  const spendVsCheckChange =
    spendVsCheckPct !== null && prevSpendVsCheckPct !== null ? pctChange(spendVsCheckPct, prevSpendVsCheckPct) : null;

  // Each "no comparison" note names the actual reason instead of a blanket
  // "нет данных" — the current period can have perfectly real data while
  // the comparison arrow is unavailable for a completely different reason
  // (no previous period at all for "Всё время", the previous period itself
  // missing data, or — the subtle one — the previous period having data but
  // zero spend/traffic, which makes the % change mathematically undefined).
  const hasPrevPeriod = range?.hasPrev ?? false;

  const planCompletionNote =
    planCompletionPct === null
      ? "нет данных за этот период"
      : !hasPrevPeriod
        ? "нет предыдущего периода для сравнения"
        : prevTotals.plan === 0
          ? "нет данных за предыдущий период для сравнения"
          : "в предыдущем периоде не было фактического трафика";

  const costPerBuyerNote =
    costPerBuyer === null
      ? "нет данных МойСклад за этот период"
      : !hasPrevPeriod
        ? "нет предыдущего периода для сравнения"
        : prevSalesTotals.receipts === 0
          ? "нет данных МойСклад за предыдущий период для сравнения"
          : "в предыдущем периоде не было расходов на маркетинг";

  const spendVsCheckNote =
    spendVsCheckPct === null
      ? "нет данных МойСклад за этот период"
      : !hasPrevPeriod
        ? "нет предыдущего периода для сравнения"
        : prevSalesTotals.receipts === 0
          ? "нет данных МойСклад за предыдущий период для сравнения"
          : "в предыдущем периоде не было расходов на маркетинг";

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

  function buildTable() {
    if (!range) return null;
    const byDate = new Map(current.map((r) => [r.entry_date, r]));
    const headers = [
      "Дата",
      "Трафик план",
      "Трафик факт",
      "Количество чеков",
      "Конверсия, %",
      "Средний чек",
      ...CHANNEL_DEFS.map((c) => c.label),
      "Итого по каналам",
    ];
    const rows: (string | number)[][] = [];
    for (let cursor = new Date(range.start); cursor <= range.end; cursor = addDays(cursor, 1)) {
      const key = ymd(cursor);
      const traffic = byDate.get(key);
      const sales = salesByDate.get(key);
      const fact = traffic?.traffic_fact ?? 0;
      const receipts = sales?.receipts ?? 0;
      const dayChannelTotal = CHANNEL_DEFS.reduce((sum, c) => sum + (traffic?.[c.key] ?? 0), 0);
      rows.push([
        // dd.mm.yyyy, not the raw ISO key — Excel's RU locale auto-detects
        // "2026-09-01" as a date too, but then renders it too wide for the
        // default column width ("####"); this format fits it cleanly.
        `${pad2(cursor.getDate())}.${pad2(cursor.getMonth() + 1)}.${cursor.getFullYear()}`,
        traffic?.traffic_plan ?? 0,
        fact,
        sales ? receipts : "",
        sales && fact > 0 ? Number(((receipts / fact) * 100).toFixed(2)) : "",
        sales && receipts > 0 ? Math.round(sales.revenue / receipts) : "",
        ...CHANNEL_DEFS.map((c) => Math.round(traffic?.[c.key] ?? 0)),
        Math.round(dayChannelTotal),
      ]);
    }
    rows.push([
      "Итого",
      totals.plan,
      totals.fact,
      salesTotals.receipts,
      conversionPct !== null ? Number(conversionPct.toFixed(2)) : "",
      avgCheck !== null ? Math.round(avgCheck) : "",
      ...CHANNEL_DEFS.map((c) => Math.round(totals[c.key])),
      Math.round(channelTotal),
    ]);
    return { headers, rows };
  }

  function handleDownload() {
    const t = buildTable();
    if (!t || !range) return;
    downloadExcel(`statistika_${ymd(range.start)}_${ymd(range.end)}.csv`, t.headers, t.rows);
  }

  // PDF: карточки с цветом по нормам, таблица «все показатели: норма и статус», что требует внимания, расходы по каналам, статистика по дням.
  // Нормы те же, что на карточках страницы: план от 100% (внимание от 90%), цена посетителя до 500 ₸ (до 600), маркетинг от среднего чека до 8% (до 9%).
  function buildStatsPdf(): PdfDoc {
    if (!range) throw new Error("Нет данных за период");
    const ru = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
    const hasPrev = range.hasPrev;
    const toneOf = (x: "positive" | "warning" | "negative"): PdfTone => (x === "positive" ? "good" : x === "warning" ? "warn" : "bad");
    const WORD: Record<PdfTone, string> = { good: "НОРМА", warn: "ВНИМАНИЕ", bad: "ПРОБЛЕМА" };
    const pv = (v: number | null) => (hasPrev ? v : null);
    const pctText = (n: number) => `${trim2Ru(n)}%`;
    const was = (v: number | null, f: (n: number) => string) => (v === null ? "" : ` · было ${f(v)}`);
    const chgText = (cur: number, prev: number) => {
      const v = pctChange(cur, prev);
      return v === null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${trim2Ru(Math.abs(v))}%`;
    };
    // для показателей без нормы: лучше / хуже, чем в прошлом периоде («больше — лучше» или «меньше — лучше»)
    const vs = (cur: number | null, prev: number | null, better: "up" | "down"): PdfTone | null => {
      if (cur === null || prev === null || cur === prev) return null;
      return (cur > prev) === (better === "up") ? "good" : "bad";
    };
    const vsWord = (x: PdfTone | null) => (x === "good" ? "лучше, чем раньше" : x === "bad" ? "хуже, чем раньше" : "как раньше");

    const prevConversion = prevTotals.fact > 0 ? (prevSalesTotals.receipts / prevTotals.fact) * 100 : null;
    const prevDone = pv(prevPlanCompletionPct);
    const prevVisitor = pv(prevCostPerVisitor);
    const prevBuyer = pv(prevCostPerBuyer);
    const prevCheckPct = pv(prevSpendVsCheckPct);
    const prevConv = pv(prevConversion);
    const prevAvg = pv(prevAvgCheck);

    const planT = planCompletionPct === null ? null : toneOf(planCompletionTone(planCompletionPct));
    const visitorT = costPerVisitor === null ? null : toneOf(costPerVisitorTone(costPerVisitor));
    const checkT = spendVsCheckPct === null ? null : toneOf(spendVsCheckTone(spendVsCheckPct));
    const buyerT = vs(costPerBuyer, prevBuyer, "down");
    const visitorsT = vs(totals.fact, hasPrev ? prevTotals.fact : null, "up");
    const receiptsT = vs(salesTotals.receipts, hasPrev ? prevSalesTotals.receipts : null, "up");
    const convT = vs(conversionPct, prevConv, "up");
    const avgT = vs(avgCheck, prevAvg, "up");

    const kpis: NonNullable<PdfDoc["kpis"]> = [
      { label: "Выполнение плана по трафику", value: planCompletionPct === null ? "не задан" : pctText(planCompletionPct), note: planT === null ? "план трафика не внесён" : `${WORD[planT]} · норма от 100%`, tone: planT ?? "warn" },
      { label: "Общий расход на маркетинг", value: money(totalSpend), note: hasPrev && prevTotalSpend > 0 ? `${chgText(totalSpend, prevTotalSpend)} к прошлому периоду` : "в прошлом периоде расхода не было" },
      { label: "Доп. расходы", value: money(expensesTotal), note: hasPrev && prevExpensesTotal > 0 ? `${chgText(expensesTotal, prevExpensesTotal)} к прошлому периоду` : "не вносились" },
      { label: "Цена одного посетителя", value: costPerVisitor === null ? "—" : money(costPerVisitor), note: visitorT === null ? undefined : `${WORD[visitorT]} · норма до 500 ₸${was(prevVisitor, money)}`, tone: visitorT ?? undefined },
      { label: "Цена одного покупателя", value: costPerBuyer === null ? "—" : money(costPerBuyer), note: costPerBuyer === null ? undefined : `${vsWord(buyerT)}${was(prevBuyer, money)}` },
      { label: "Маркетинг, % от среднего чека", value: spendVsCheckPct === null ? "—" : pctText(spendVsCheckPct), note: checkT === null ? undefined : `${WORD[checkT]} · норма до 8% · чек ${avgCheck === null ? "—" : money(avgCheck)}`, tone: checkT ?? undefined },
    ];

    type Row = { label: string; value: string; norm: string; status: string; tone: PdfTone | null; prev: string };
    const rows: Row[] = [
      { label: "Выполнение плана по трафику", value: planCompletionPct === null ? "не задан" : pctText(planCompletionPct), norm: "от 100%", status: planT === null ? "план не внесён" : WORD[planT], tone: planT ?? "warn", prev: prevDone === null ? "—" : pctText(prevDone) },
      { label: "Цена одного посетителя", value: costPerVisitor === null ? "—" : money(costPerVisitor), norm: "до 500 ₸ (внимание до 600 ₸)", status: visitorT ? WORD[visitorT] : "—", tone: visitorT, prev: prevVisitor === null ? "—" : money(prevVisitor) },
      { label: "Маркетинг, % от среднего чека", value: spendVsCheckPct === null ? "—" : pctText(spendVsCheckPct), norm: "до 8% (внимание до 9%)", status: checkT ? WORD[checkT] : "—", tone: checkT, prev: prevCheckPct === null ? "—" : pctText(prevCheckPct) },
      { label: "Цена одного покупателя", value: costPerBuyer === null ? "—" : money(costPerBuyer), norm: "нормы нет, меньше — лучше", status: costPerBuyer === null ? "—" : vsWord(buyerT), tone: buyerT, prev: prevBuyer === null ? "—" : money(prevBuyer) },
      { label: "Общий расход на маркетинг", value: money(totalSpend), norm: "нормы нет", status: "—", tone: null, prev: hasPrev ? money(prevTotalSpend) : "—" },
      { label: "Посетители", value: trafficText(totals.fact), norm: "нормы нет, больше — лучше", status: vsWord(visitorsT), tone: visitorsT, prev: hasPrev ? trafficText(prevTotals.fact) : "—" },
      { label: "Чеки (покупки)", value: String(salesTotals.receipts), norm: "нормы нет, больше — лучше", status: vsWord(receiptsT), tone: receiptsT, prev: hasPrev ? String(prevSalesTotals.receipts) : "—" },
      { label: "Из 100 посетителей купили", value: conversionPct === null ? "—" : trim2Ru(conversionPct), norm: "нормы нет, больше — лучше", status: conversionPct === null ? "—" : vsWord(convT), tone: convT, prev: prevConv === null ? "—" : trim2Ru(prevConv) },
      { label: "Средний чек", value: avgCheck === null ? "—" : money(avgCheck), norm: "нормы нет, больше — лучше", status: avgCheck === null ? "—" : vsWord(avgT), tone: avgT, prev: prevAvg === null ? "—" : money(prevAvg) },
    ];

    const attn: string[] = [];
    if (planCompletionPct === null) attn.push("План трафика на этот период не внесён — выполнение плана посчитать нельзя.");
    else if (planT !== "good") attn.push(`План по трафику выполнен на ${pctText(planCompletionPct)} — ниже нормы (от 100%).`);
    if (visitorT && visitorT !== "good" && costPerVisitor !== null) attn.push(`Цена одного посетителя ${money(costPerVisitor)} — выше нормы (до 500 ₸).`);
    if (checkT && checkT !== "good" && spendVsCheckPct !== null) attn.push(`Маркетинг съел ${pctText(spendVsCheckPct)} среднего чека — выше нормы (до 8%).`);
    for (const r of rows) if (r.tone === "bad" && r.norm.startsWith("нормы нет")) attn.push(`${r.label}: ${r.value} — хуже, чем в прошлом периоде (${r.prev}).`);
    if (attn.length === 0) attn.push("По нормам портала проблем нет.");

    const chSum = CHANNEL_DEFS.map((c) => ({ label: c.label, cur: totals[c.key], prev: hasPrev ? prevTotals[c.key] : 0 })).sort((a, b) => b.cur - a.cur);
    const chRows: (string | number)[][] = chSum
      .filter((x) => x.cur > 0 || x.prev > 0)
      .map((x) => [x.label, money(x.cur), channelTotal > 0 ? pctText((x.cur / channelTotal) * 100) : "—", hasPrev ? money(x.prev) : "—", x.prev > 0 ? chgText(x.cur, x.prev) : "—"]);
    chRows.push(["Всего по каналам", money(channelTotal), "100%", hasPrev ? money(prevChannelTotal) : "—", prevChannelTotal > 0 ? chgText(channelTotal, prevChannelTotal) : "—"]);

    // при нескольких городах за одну дату строк несколько — складываем
    const byDate = new Map<string, { fact: number; spend: number }>();
    for (const r of current) {
      const a = byDate.get(r.entry_date) ?? { fact: 0, spend: 0 };
      a.fact += r.traffic_fact ?? 0;
      a.spend += CHANNEL_DEFS.reduce((sum, c) => sum + (r[c.key] ?? 0), 0);
      byDate.set(r.entry_date, a);
    }
    const days: (string | number)[][] = [];
    for (let cursor = new Date(range.start); cursor <= range.end; cursor = addDays(cursor, 1)) {
      const key = ymd(cursor);
      const sl = salesByDate.get(key);
      const fact = byDate.get(key)?.fact ?? 0;
      const sp = byDate.get(key)?.spend ?? 0;
      days.push([
        `${WEEKDAYS[cursor.getDay()]}, ${pad2(cursor.getDate())}.${pad2(cursor.getMonth() + 1)}`,
        trafficText(fact),
        sl ? String(sl.receipts) : "—",
        sl && fact > 0 ? trim2Ru((sl.receipts / fact) * 100) : "—",
        sl && sl.receipts > 0 ? money(sl.revenue / sl.receipts) : "—",
        money(sp),
        fact > 0 ? money(sp / fact) : "—",
      ]);
    }
    days.push(["Итого", trafficText(totals.fact), String(salesTotals.receipts), conversionPct === null ? "—" : trim2Ru(conversionPct), avgCheck === null ? "—" : money(avgCheck), money(channelTotal), totals.fact > 0 ? money(channelTotal / totals.fact) : "—"]);

    const prevLabel = hasPrev ? `Прошлый период: ${ru(range.prevStart)}${range.prevStart.getTime() === range.prevEnd.getTime() ? "" : ` — ${ru(range.prevEnd)}`}. ` : "";
    return {
      fileName: `Статистика ${ruPeriod(ymd(range.start), ymd(range.end))}`,
      title: "Статистика маркетинга",
      subtitle: `${ru(range.start)} — ${ru(range.end)}`,
      meta: [`${prevLabel}Цвета: зелёный — норма, жёлтый — внимание, красный — проблема. Нормы те же, что на карточках страницы «Маркетинг — Статистика».`],
      orientation: "landscape",
      fixedKpis: true,
      kpis,
      sections: [
        {
          title: "Все показатели: норма и статус",
          fixed: true,
          headers: ["Показатель", "Сейчас", "Норма", "Статус", "В прошлом периоде"],
          rows: rows.map((r) => [r.label, r.value, r.norm, r.status, r.prev]),
          tones: rows.map((r) => [null, null, null, r.tone, null]),
          align: ["left", "right", "left", "left", "right"],
          widths: [2.6, 1.4, 2.6, 1.9, 1.5],
        },
        { title: "Что требует внимания", fixed: true, headers: ["Коротко"], rows: attn.map((a) => [a]), align: ["left"], fontSize: 9.4 },
        {
          title: "Куда ушли деньги",
          fixed: true,
          headers: ["Канал", "Потратили", "Доля", "В прошлом периоде", "Изменение"],
          rows: chRows,
          rowKinds: chRows.map((_, i) => (i === chRows.length - 1 ? "total" : "normal")),
          align: ["left", "right", "right", "right", "right"],
          widths: [2.4, 1.6, 1, 1.6, 1.2],
        },
        {
          title: "Статистика по дням",
          fixed: true,
          note: "«Из 100 купили» — сколько человек из ста вошедших сделали покупку. «Цена посетителя» — расход по каналам ÷ посетители за день.",
          headers: ["День", "Посетителей", "Чеков", "Из 100 купили", "Средний чек", "Расход по каналам", "Цена посетителя"],
          rows: days,
          rowKinds: days.map((_, i) => (i === days.length - 1 ? "total" : "normal")),
          align: ["left", "right", "right", "right", "right", "right", "right"],
        },
      ],
    };
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Маркетинг</div>
        <div className="flex items-center gap-2.5 justify-between">
          <h1 className="font-serif text-[28px] font-semibold m-0">Статистика</h1>
          <div className="flex items-center gap-2">
          <PdfButton
            disabled={loading || !range || current.length === 0}
            build={buildStatsPdf}
            className="text-[13px] font-semibold text-muted border border-border rounded-md px-3 py-2 hover:bg-paper disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleDownload}
            disabled={loading || !range || current.length === 0}
            className="flex items-center gap-1.5 text-[13px] font-semibold text-muted border border-border rounded-md px-3 py-2 hover:bg-paper disabled:opacity-50"
            title="Скачать в Excel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
            Скачать
          </button>
          </div>
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        <KpiCard
          label="Выполнение плана по трафику"
          value={totals.plan > 0 ? `${trim2((totals.fact / totals.plan) * 100)}%` : "—"}
          valueTone={totals.plan > 0 ? planCompletionTone((totals.fact / totals.plan) * 100) : "neutral"}
          valueSuffix={
            totals.plan > 0
              ? `(${trafficText(totals.fact)} из ${trafficText(totals.plan)}${
                  trafficShortfall > 0 ? ` · не хватает ${trafficText(trafficShortfall)}` : ""
                })`
              : undefined
          }
          note={
            planCompletionChange !== null
              ? `${planCompletionChange >= 0 ? "▲" : "▼"} ${trim2(Math.abs(planCompletionChange))}% к пред. периоду`
              : planCompletionNote
          }
          noteTone={planCompletionChange !== null ? (planCompletionChange >= 0 ? "positive" : "negative") : "neutral"}
        />
        <KpiCard
          label="Общий расход на маркетинг"
          value={money(totalSpend)}
          note={spendChange !== null ? `${spendChange >= 0 ? "▲" : "▼"} ${trim2(Math.abs(spendChange))}% к пред. периоду` : undefined}
          noteTone={spendChange !== null ? (spendChange >= 0 ? "negative" : "positive") : "neutral"}
        />
        <KpiCard
          label="Доп. расходы"
          value={money(expensesTotal)}
          note={expensesChange !== null ? `${expensesChange >= 0 ? "▲" : "▼"} ${trim2(Math.abs(expensesChange))}% к пред. периоду` : undefined}
          noteTone={expensesChange !== null ? (expensesChange >= 0 ? "negative" : "positive") : "neutral"}
        />
        <KpiCard
          label="Цена одного посетителя"
          value={costPerVisitor !== null ? money(costPerVisitor) : "—"}
          valueTone={costPerVisitor !== null ? costPerVisitorTone(costPerVisitor) : "neutral"}
          note={costChange !== null ? `${costChange >= 0 ? "▲" : "▼"} ${trim2(Math.abs(costChange))}% к пред. периоду` : undefined}
          noteTone={costChange !== null ? (costChange >= 0 ? "negative" : "positive") : "neutral"}
        />
        <KpiCard
          label="Цена одного покупателя"
          value={costPerBuyer !== null ? money(costPerBuyer) : "—"}
          valueSuffix={conversionPct !== null ? `(${trim2(conversionPct)}%)` : undefined}
          note={
            costPerBuyerChange !== null
              ? `${costPerBuyerChange >= 0 ? "▲" : "▼"} ${trim2(Math.abs(costPerBuyerChange))}% к пред. периоду`
              : costPerBuyerNote
          }
          noteTone={costPerBuyerChange !== null ? (costPerBuyerChange >= 0 ? "negative" : "positive") : "neutral"}
        />
        <KpiCard
          label="Маркетинг, % от среднего чека"
          value={spendVsCheckPct !== null ? `${trim2(spendVsCheckPct)}%` : "—"}
          valueTone={spendVsCheckPct !== null ? spendVsCheckTone(spendVsCheckPct) : "neutral"}
          valueSuffix={avgCheck !== null ? `(${money(avgCheck)})` : undefined}
          note={
            spendVsCheckChange !== null
              ? `${spendVsCheckChange >= 0 ? "▲" : "▼"} ${trim2(Math.abs(spendVsCheckChange))}% к пред. периоду`
              : spendVsCheckNote
          }
          noteTone={spendVsCheckChange !== null ? (spendVsCheckChange >= 0 ? "negative" : "positive") : "neutral"}
        />
      </div>

      {/* Traffic chart + channel spend */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4 items-stretch">
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
