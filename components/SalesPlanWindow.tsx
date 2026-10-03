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

// Окно «План продаж» (Обзор и Продажа): план на текущий месяц по выбранным
// точкам, факт выручки с 1-го числа (МойСклад синхронизируется ночью за
// вчера, сегодняшнего дня в факте ещё нет), процент выполнения и сколько
// нужно продавать в день до конца месяца, считая сегодняшний день.
// `refreshKey` меняется, когда план внесли заново (страница «Продажа»).
export function SalesPlanWindow({ stores, refreshKey = 0 }: { stores: string[]; refreshKey?: number }) {
  const [plan, setPlan] = useState(0);
  const [fact, setFact] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const monthEnd = new Date(today.getFullYear(), today.getMonth(), daysInMonth);
  const storesKey = stores.join(",");

  useEffect(() => {
    if (stores.length === 0) {
      setPlan(0);
      setFact(0);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [planRes, factRes] = await Promise.all([
          supabase
            .from("sales_plan_entries")
            .select("store, sales_plan")
            .in("store", stores)
            .gte("entry_date", ymd(monthStart))
            .lte("entry_date", ymd(monthEnd)),
          supabase
            .from("moysklad_sales_daily")
            .select("revenue, moysklad_registers(store)")
            .gte("sale_date", ymd(monthStart))
            .lte("sale_date", ymd(today)),
        ]);
        if (planRes.error) throw planRes.error;
        if (factRes.error) throw factRes.error;
        if (cancelled) return;

        setPlan((planRes.data ?? []).reduce((acc, r) => acc + (Number(r.sales_plan) || 0), 0));
        type FactRow = {
          revenue: number;
          moysklad_registers: { store: string | null } | { store: string | null }[] | null;
        };
        let factSum = 0;
        for (const row of (factRes.data ?? []) as unknown as FactRow[]) {
          const reg = Array.isArray(row.moysklad_registers) ? row.moysklad_registers[0] : row.moysklad_registers;
          if (reg?.store && stores.includes(reg.store)) factSum += Number(row.revenue) || 0;
        }
        setFact(factSum);
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

  const daysLeft = daysInMonth - today.getDate() + 1;
  const pct = plan > 0 ? (fact / plan) * 100 : null;
  const perDay = plan > 0 && daysLeft > 0 ? Math.max(0, plan - fact) / daysLeft : null;

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

          {plan <= 0 && (
            <div className="text-[12.5px] text-muted">
              План на этот месяц не внесён — вносится в разделе «Продажа», внизу страницы.
            </div>
          )}
        </>
      )}
    </div>
  );
}
