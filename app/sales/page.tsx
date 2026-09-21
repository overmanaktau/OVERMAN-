"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

const PERIODS = ["Прошлая неделя", "Эта неделя", "С начала месяца", "30 дней", "Всё время"];
const DEFAULT_PERIOD = 2; // "С начала месяца"

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

  if (index === 0) return { start: addDays(thisMonday, -7), end: addDays(thisSunday, -7) };
  if (index === 1) return { start: thisMonday, end: thisSunday };
  if (index === 2) return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: d };
  if (index === 3) return { start: addDays(d, -29), end: d };
  return { start: new Date(2000, 0, 1), end: d }; // "Всё время"
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

type RegisterSalesRow = {
  registerId: string;
  name: string;
  store: string | null;
  revenue: number;
  receipts: number;
  items: number;
  cost: number | null;
};

export default function SalesPage() {
  const { isAdmin, permissions, stores } = useAuth();
  const { selected: selectedStores } = useStoreSelection();
  const canView = isAdmin || permissions["marketing.statistics"].canView;

  const [periodIndex, setPeriodIndex] = useState(DEFAULT_PERIOD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerSales, setRegisterSales] = useState<RegisterSalesRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = getPeriodRange(periodIndex, new Date());
      const { data, error: registerError } = await supabase
        .from("moysklad_sales_daily")
        .select("register_id, revenue, receipts_count, items_count, cost, moysklad_registers(name, store)")
        .gte("sale_date", ymd(r.start))
        .lte("sale_date", ymd(r.end));
      if (registerError) throw registerError;

      type Agg = {
        registerId: string;
        name: string;
        store: string | null;
        revenue: number;
        receipts: number;
        items: number;
        costSum: number;
        costMissing: boolean;
      };
      const byRegister = new Map<string, Agg>();
      for (const row of (data ?? []) as unknown as {
        register_id: string;
        revenue: number;
        receipts_count: number;
        items_count: number;
        cost: number | null;
        moysklad_registers: { name: string; store: string | null } | null;
      }[]) {
        const agg = byRegister.get(row.register_id) ?? {
          registerId: row.register_id,
          name: row.moysklad_registers?.name ?? row.register_id,
          store: row.moysklad_registers?.store ?? null,
          revenue: 0,
          receipts: 0,
          items: 0,
          costSum: 0,
          costMissing: false,
        };
        agg.revenue += row.revenue ?? 0;
        agg.receipts += row.receipts_count ?? 0;
        agg.items += row.items_count ?? 0;
        // A missing value means "unknown", not zero — one day without cost
        // data makes the whole period's margin unknown, since averaging in
        // a false zero would inflate it.
        if (row.cost === null) agg.costMissing = true;
        else agg.costSum += row.cost;
        byRegister.set(row.register_id, agg);
      }

      const rows: RegisterSalesRow[] = [...byRegister.values()]
        .filter((a) => !a.store || selectedStores.includes(a.store))
        .map((a) => ({
          registerId: a.registerId,
          name: a.name,
          store: a.store,
          revenue: a.revenue,
          receipts: a.receipts,
          items: a.items,
          cost: a.costMissing ? null : a.costSum,
        }))
        .sort((a, b) => b.revenue - a.revenue);
      setRegisterSales(rows);
    } catch (e) {
      setError(friendlyError(e));
      setRegisterSales([]);
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
        <p className="text-sm text-muted">У вас нет доступа к разделу «Продажа».</p>
      </div>
    );
  }

  const totalRevenue = registerSales.reduce((acc, r) => acc + r.revenue, 0);
  const totalReceipts = registerSales.reduce((acc, r) => acc + r.receipts, 0);
  const totalItems = registerSales.reduce((acc, r) => acc + r.items, 0);

  function storeLabel(code: string | null) {
    if (!code) return "—";
    return stores.find((s) => s.code === code)?.name ?? code;
  }

  // Grouped by city, in the same order cities appear everywhere else in the
  // app — Актау's points together, then Актобе's, each with its own subtotal.
  const cityGroups: { store: string | null; label: string; rows: RegisterSalesRow[] }[] = [
    ...stores.map((s) => ({ store: s.code, label: s.name, rows: [] as RegisterSalesRow[] })),
    { store: null, label: "Без города", rows: [] as RegisterSalesRow[] },
  ];
  for (const r of registerSales) {
    const group = cityGroups.find((g) => g.store === r.store) ?? cityGroups[cityGroups.length - 1];
    group.rows.push(r);
  }
  const visibleGroups = cityGroups.filter((g) => g.rows.length > 0);

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Общее</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Продажа</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Продажи по кассам из МойСклад — обновляются раз в сутки, здесь ничего не считается
          в реальном времени. Возвраты уже вычтены из выручки и количества товара; число чеков
          при этом не уменьшается — возврат считается изменением уже пробитого чека, а не новым.
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
      </div>

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        <div className="text-[15px] font-bold">Продажи по кассам</div>
        {loading ? (
          <div className="text-sm text-muted py-4">Загрузка…</div>
        ) : registerSales.length === 0 ? (
          <div className="text-sm text-muted py-4">Нет данных за этот период.</div>
        ) : (
          <>
            <div className="grid grid-cols-[1.3fr_0.9fr_1fr_0.6fr_1fr_0.9fr_0.9fr_0.8fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Касса</div>
              <div>Город</div>
              <div>Выручка</div>
              <div>Чеков</div>
              <div>Средний чек</div>
              <div>Кол-во товара</div>
              <div>Глубина чека</div>
              <div>Маржа %</div>
            </div>
            {visibleGroups.map((group) => {
              const groupRevenue = group.rows.reduce((acc, r) => acc + r.revenue, 0);
              const groupReceipts = group.rows.reduce((acc, r) => acc + r.receipts, 0);
              const groupItems = group.rows.reduce((acc, r) => acc + r.items, 0);
              return (
                <div key={group.store ?? "none"}>
                  {group.rows.map((r) => {
                    const avgCheck = r.receipts > 0 ? r.revenue / r.receipts : 0;
                    const checkDepth = r.receipts > 0 ? r.items / r.receipts : 0;
                    const marginPct = r.cost !== null && r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : null;
                    return (
                      <div
                        key={r.registerId}
                        className="grid grid-cols-[1.3fr_0.9fr_1fr_0.6fr_1fr_0.9fr_0.9fr_0.8fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
                      >
                        <div className="font-semibold">{r.name}</div>
                        <div className="text-muted">{storeLabel(r.store)}</div>
                        <div className="num">{money(r.revenue)}</div>
                        <div className="num">{r.receipts}</div>
                        <div className="num">{money(avgCheck)}</div>
                        <div className="num">{r.items.toLocaleString("ru-RU")}</div>
                        <div className="num">{checkDepth.toFixed(1)}</div>
                        <div className="num">{marginPct !== null ? `${marginPct.toFixed(0)}%` : "—"}</div>
                      </div>
                    );
                  })}
                  {group.rows.length > 1 && (
                    <div className="grid grid-cols-[1.3fr_0.9fr_1fr_0.6fr_1fr_0.9fr_0.9fr_0.8fr] gap-3 py-2 border-b border-borderSoft items-center text-[12.5px] font-bold bg-weekendTint">
                      <div className="col-span-2">Итого по {group.label}</div>
                      <div className="num">{money(groupRevenue)}</div>
                      <div className="num">{groupReceipts}</div>
                      <div className="num">{groupReceipts > 0 ? money(groupRevenue / groupReceipts) : "—"}</div>
                      <div className="num">{groupItems.toLocaleString("ru-RU")}</div>
                      <div />
                      <div />
                    </div>
                  )}
                </div>
              );
            })}
            <div className="grid grid-cols-[1.3fr_0.9fr_1fr_0.6fr_1fr_0.9fr_0.9fr_0.8fr] gap-3 pt-2.5 border-t-2 border-[#E4DFC8] text-[13px] font-bold">
              <div className="col-span-2">Итого</div>
              <div className="num">{money(totalRevenue)}</div>
              <div className="num">{totalReceipts}</div>
              <div className="num">{totalReceipts > 0 ? money(totalRevenue / totalReceipts) : "—"}</div>
              <div className="num">{totalItems.toLocaleString("ru-RU")}</div>
              <div />
              <div />
            </div>
          </>
        )}
      </div>
    </>
  );
}
