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

// Выбранный на странице период (Вчера, Прошлая неделя, Свой период и т.д.).
export type PlanRange = { from: string; to: string; label: string };

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

// Окно «План продаж» для выбранного периода (не «с начала месяца»): план периода —
// сумма дневных планов по точкам. Дневной план = план месяца точки × процент периода
// месяца, в который попадает день, ÷ число дней этого периода; если периоды месяца не
// заданы — план месяца ÷ число дней месяца; день вне заданных периодов — 0. Факт —
// выручка за дни периода (по вчера). Планы разных месяцев берутся каждый свой.
function PeriodPlanWindow({ stores, refreshKey = 0, range }: { stores: string[]; refreshKey?: number; range: PlanRange }) {
  const [plans, setPlans] = useState<{ store: string; plan_month: string; sales_plan: number | null }[]>([]);
  const [periods, setPeriods] = useState<(PeriodRow & { plan_month: string })[]>([]);
  const [factRows, setFactRows] = useState<FactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const todayStr = ymd(new Date());
  const storesKey = stores.join(",");

  useEffect(() => {
    if (stores.length === 0) {
      setPlans([]);
      setPeriods([]);
      setFactRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const firstMonth = `${range.from.slice(0, 8)}01`;
        const factTo = range.to < todayStr ? range.to : todayStr;
        const [planRes, periodsRes] = await Promise.all([
          supabase
            .from("sales_plan_monthly")
            .select("store, plan_month, sales_plan")
            .in("store", stores)
            .gte("plan_month", firstMonth)
            .lte("plan_month", range.to),
          supabase
            .from("sales_plan_periods")
            .select("*")
            .in("store", stores)
            .gte("plan_month", firstMonth)
            .lte("plan_month", range.to),
        ]);
        if (planRes.error) throw planRes.error;
        if (periodsRes.error) throw periodsRes.error;

        // Факт постранично: за длинный период строк больше 1000, а сервер отдаёт не больше за запрос.
        const facts: FactRow[] = [];
        for (let offset = 0; range.from <= factTo; offset += 1000) {
          const { data, error: factError } = await supabase
            .from("moysklad_sales_daily")
            .select("sale_date, revenue, register_id, moysklad_registers(store)")
            .gte("sale_date", range.from)
            .lte("sale_date", factTo)
            .order("sale_date")
            .order("register_id")
            .range(offset, offset + 999);
          if (factError) throw factError;
          type Raw = {
            sale_date: string;
            revenue: number;
            moysklad_registers: { store: string | null } | { store: string | null }[] | null;
          };
          for (const row of (data ?? []) as unknown as Raw[]) {
            const reg = Array.isArray(row.moysklad_registers) ? row.moysklad_registers[0] : row.moysklad_registers;
            if (reg?.store && stores.includes(reg.store)) {
              facts.push({ store: reg.store, date: row.sale_date, revenue: Number(row.revenue) || 0 });
            }
          }
          if (!data || data.length < 1000) break;
        }
        if (cancelled) return;
        setPlans((planRes.data ?? []) as { store: string; plan_month: string; sales_plan: number | null }[]);
        setPeriods((periodsRes.data ?? []) as (PeriodRow & { plan_month: string })[]);
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
  }, [storesKey, refreshKey, range.from, range.to]);

  // План периода: по каждому месяцу с планом суммируем дневные планы дней, попавших в период.
  let plan = 0;
  for (const p of plans) {
    const monthPlan = Number(p.sales_plan) || 0;
    if (monthPlan <= 0) continue;
    const [y, m] = p.plan_month.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const row = periods.find((r) => r.store === p.store && r.plan_month === p.plan_month);
    const candidates = row
      ? [
          { from: row.p1_from, to: row.p1_to, percent: row.p1_percent },
          { from: row.p2_from, to: row.p2_to, percent: row.p2_percent },
        ]
      : null;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${y}-${pad2(m)}-${pad2(d)}`;
      if (date < range.from || date > range.to) continue;
      if (!candidates) {
        plan += monthPlan / daysInMonth;
        continue;
      }
      const cur = candidates.find((c) => c.from && c.to && c.from <= date && date <= c.to);
      if (!cur || !cur.from || !cur.to) continue; // день вне заданных периодов
      plan += (monthPlan * (Number(cur.percent) || 0)) / 100 / (daysBetween(cur.from, cur.to) + 1);
    }
  }
  // Факт сравниваем с планом только по тем точкам и месяцам, где план внесён: иначе
  // выручка точки без плана (или месяцев без плана при «Всё время») раздувала бы процент.
  const plannedMonths = new Set(plans.filter((p) => (Number(p.sales_plan) || 0) > 0).map((p) => `${p.store}|${p.plan_month.slice(0, 7)}`));
  const fact = factRows.filter((r) => plannedMonths.has(`${r.store}|${r.date.slice(0, 7)}`)).reduce((a, r) => a + r.revenue, 0);
  const totalFact = factRows.reduce((a, r) => a + r.revenue, 0);
  const pct = plan > 0 ? (fact / plan) * 100 : null;
  // Если в периоде есть дни впереди (например, «Эта неделя»), показываем, сколько нужно в день.
  const hasFuture = range.to >= todayStr;
  const daysLeft = hasFuture ? daysBetween(todayStr, range.to) + 1 : 0;
  const perDay = plan > 0 && daysLeft > 0 ? Math.max(0, plan - fact) / daysLeft : null;
  const dates = range.from === range.to ? shortDate(range.from) : `${shortDate(range.from)}–${shortDate(range.to)}`;

  return (
    <div className="bg-surface border border-border rounded-card p-5 flex flex-col gap-3.5">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-sm font-bold">
          План продаж — {range.label.toLowerCase()} ({dates})
        </div>
        <div className="text-xs text-mutedLight">план по дням из периодов месяца, факт — выручка по вчера</div>
      </div>

      {error ? (
        <div className="text-sm text-[#A34B36]">Не удалось загрузить план продаж: {error}</div>
      ) : loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">План периода</div>
              <div className="font-serif text-[22px] font-semibold num">{plan > 0 ? money(plan) : "—"}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Факт периода</div>
              <div className="font-serif text-[22px] font-semibold num">{money(fact)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Выполнение</div>
              <div className="font-serif text-[22px] font-semibold num">{pct !== null ? `${pct.toFixed(2)}%` : "—"}</div>
            </div>
            {hasFuture && (
              <div className="flex flex-col gap-1.5">
                <div className="text-xs text-muted">Нужно в день до конца периода</div>
                <div className="font-serif text-[22px] font-semibold num">{perDay !== null ? money(perDay) : "—"}</div>
              </div>
            )}
          </div>

          {pct !== null && (
            <div className="h-2 rounded-full bg-[#EDE9DB] overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
            </div>
          )}

          {plan > 0 && Math.round(totalFact) !== Math.round(fact) && (
            <div className="text-[12.5px] text-muted">
              Факт — только по точкам и месяцам, где внесён план; вся выручка за период — {money(totalFact)}.
            </div>
          )}

          {plan <= 0 && <div className="text-[12.5px] text-muted">На этот период план не внесён — он вносится по продавцам в разделе «Продажа» внизу страницы.</div>}
        </>
      )}
    </div>
  );
}

// «Обзор» и «Продажа с начала месяца» — окно текущего месяца; любой другой выбранный период —
// окно плана этого периода.
export function SalesPlanWindow({ stores, refreshKey = 0, range }: { stores: string[]; refreshKey?: number; range?: PlanRange | null }) {
  if (range) return <PeriodPlanWindow stores={stores} refreshKey={refreshKey} range={range} />;
  return <MonthPlanWindow stores={stores} refreshKey={refreshKey} />;
}

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
function MonthPlanWindow({ stores, refreshKey = 0 }: { stores: string[]; refreshKey?: number }) {
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
