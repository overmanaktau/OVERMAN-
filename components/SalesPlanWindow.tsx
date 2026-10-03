"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

const MONTH_NAMES = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function ymd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}
function shortDate(date: string) {
  const [, m, d] = date.split("-");
  return `${d}.${m}`;
}
function daysBetween(fromYmd: string, toYmd: string) {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

type PeriodRow = {
  store: string;
  p1_from: string | null;
  p1_to: string | null;
  p1_percent: number | null;
  p2_from: string | null;
  p2_to: string | null;
  p2_percent: number | null;
};
type FactRow = { store: string; date: string; revenue: number };

// Окно «План продаж» (Обзор и Продажа): план на текущий месяц по выбранным
// точкам (сумма планов продавцов), факт выручки с 1-го числа (МойСклад
// синхронизируется ночью за вчера, сегодняшнего дня в факте ещё нет), процент
// выполнения и сколько нужно продавать в день до конца месяца: недобор плана
// делится поровну на оставшиеся дни, считая сегодняшний (его продаж в факте
// ещё нет).
// Если для точки заданы периоды месяца с процентами, ниже те же цифры по
// текущему периоду: план периода = месячный план точки × процент периода,
// факт — выручка за дни периода, «нужно в день» — недобор периода на
// оставшиеся дни периода. `refreshKey` меняется, когда план внесли заново.
export function SalesPlanWindow({ stores, refreshKey = 0 }: { stores: string[]; refreshKey?: number }) {
  const [planByStore, setPlanByStore] = useState<Record<string, number>>({});
  const [periodRows, setPeriodRows] = useState<PeriodRow[]>([]);
  const [factRows, setFactRows] = useState<FactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const today = new Date();
  const todayStr = ymd(today);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const storesKey = stores.join(",");

  useEffect(() => {
    if (stores.length === 0) {
      setPlanByStore({});
      setPeriodRows([]);
      setFactRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const month = ymd(monthStart);
        const [planRes, periodsRes, factRes] = await Promise.all([
          supabase.from("sales_plan_monthly").select("store, sales_plan").in("store", stores).eq("plan_month", month),
          supabase.from("sales_plan_periods").select("*").in("store", stores).eq("plan_month", month),
          supabase
            .from("moysklad_sales_daily")
            .select("sale_date, revenue, moysklad_registers(store)")
            .gte("sale_date", month)
            .lte("sale_date", todayStr),
        ]);
        if (planRes.error) throw planRes.error;
        if (periodsRes.error) throw periodsRes.error;
        if (factRes.error) throw factRes.error;
        if (cancelled) return;

        const byStore: Record<string, number> = {};
        for (const r of (planRes.data ?? []) as { store: string; sales_plan: number | null }[]) {
          byStore[r.store] = (byStore[r.store] ?? 0) + (Number(r.sales_plan) || 0);
        }
        setPlanByStore(byStore);
        setPeriodRows((periodsRes.data ?? []) as PeriodRow[]);

        type RawFact = {
          sale_date: string;
          revenue: number;
          moysklad_registers: { store: string | null } | { store: string | null }[] | null;
        };
        const facts: FactRow[] = [];
        for (const row of (factRes.data ?? []) as unknown as RawFact[]) {
          const reg = Array.isArray(row.moysklad_registers) ? row.moysklad_registers[0] : row.moysklad_registers;
          if (reg?.store && stores.includes(reg.store)) {
            facts.push({ store: reg.store, date: row.sale_date, revenue: Number(row.revenue) || 0 });
          }
        }
        setFactRows(facts);
      } catch (e) {
        if (!cancelled) setError(getErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storesKey, refreshKey]);

  const plan = Object.values(planByStore).reduce((a, b) => a + b, 0);
  const fact = factRows.reduce((a, r) => a + r.revenue, 0);
  const daysLeft = daysInMonth - today.getDate() + 1;
  const pct = plan > 0 ? (fact / plan) * 100 : null;
  const perDay = plan > 0 && daysLeft > 0 ? Math.max(0, plan - fact) / daysLeft : null;

  // Текущий период по каждой точке, где он задан и сегодня попадает в него.
  let periodPlan = 0;
  let periodFact = 0;
  let periodNeed = 0;
  const periodLabels = new Set<string>();
  for (const row of periodRows) {
    const candidates = [
      { from: row.p1_from, to: row.p1_to, percent: row.p1_percent },
      { from: row.p2_from, to: row.p2_to, percent: row.p2_percent },
    ];
    const current = candidates.find((c) => c.from && c.to && c.from <= todayStr && todayStr <= c.to);
    if (!current || !current.from || !current.to) continue;
    const storePlan = ((planByStore[row.store] ?? 0) * (Number(current.percent) || 0)) / 100;
    const storeFact = factRows
      .filter((r) => r.store === row.store && r.date >= current.from! && r.date <= current.to!)
      .reduce((a, r) => a + r.revenue, 0);
    const daysLeftPeriod = daysBetween(todayStr, current.to) + 1;
    periodPlan += storePlan;
    periodFact += storeFact;
    if (storePlan > 0 && daysLeftPeriod > 0) periodNeed += Math.max(0, storePlan - storeFact) / daysLeftPeriod;
    periodLabels.add(`${shortDate(current.from)}–${shortDate(current.to)} (${Number(current.percent) || 0}%)`);
  }
  const hasPeriod = periodLabels.size > 0;
  const periodPct = periodPlan > 0 ? (periodFact / periodPlan) * 100 : null;

  return (
    <div className="bg-surface border border-border rounded-card p-5 flex flex-col gap-3.5">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-sm font-bold">
          План продаж — {MONTH_NAMES[today.getMonth()]} {today.getFullYear()}
        </div>
        <div className="text-xs text-mutedLight">выручка с 1-го числа по вчера</div>
      </div>

      {error ? (
        <div className="text-sm text-[#A34B36]">Не удалось загрузить план продаж: {error}</div>
      ) : loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">План на месяц</div>
              <div className="font-serif text-[22px] font-semibold num">{plan > 0 ? money(plan) : "—"}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Факт</div>
              <div className="font-serif text-[22px] font-semibold num">{money(fact)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Выполнение</div>
              <div className="font-serif text-[22px] font-semibold num">{pct !== null ? `${pct.toFixed(2)}%` : "—"}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Нужно в день до конца месяца</div>
              <div className="font-serif text-[22px] font-semibold num">{perDay !== null ? money(perDay) : "—"}</div>
            </div>
          </div>

          {pct !== null && (
            <div className="h-2 rounded-full bg-[#EDE9DB] overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
            </div>
          )}

          {hasPeriod && (
            <div className="flex flex-col gap-3 pt-3.5 border-t border-borderSoft">
              <div className="text-[13px] font-bold">Текущий период: {[...periodLabels].join(" · ")}</div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="flex flex-col gap-1.5">
                  <div className="text-xs text-muted">План периода</div>
                  <div className="font-serif text-[22px] font-semibold num">{periodPlan > 0 ? money(periodPlan) : "—"}</div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="text-xs text-muted">Факт периода</div>
                  <div className="font-serif text-[22px] font-semibold num">{money(periodFact)}</div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="text-xs text-muted">Выполнение периода</div>
                  <div className="font-serif text-[22px] font-semibold num">
                    {periodPct !== null ? `${periodPct.toFixed(2)}%` : "—"}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="text-xs text-muted">Нужно в день до конца периода</div>
                  <div className="font-serif text-[22px] font-semibold num">{periodPlan > 0 ? money(periodNeed) : "—"}</div>
                </div>
              </div>
            </div>
          )}

          {plan <= 0 && (
            <div className="text-[12.5px] text-muted">
              План на этот месяц не внесён — вносится по продавцам в разделе «Продажа», кнопка «Внесение плана
              продаж по сотрудникам» внизу страницы.
            </div>
          )}
        </>
      )}
    </div>
  );
}
