"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

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
  if (index === 3) return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: d };
  if (index === 4) {
    // Прошлый месяц
    return { start: new Date(d.getFullYear(), d.getMonth() - 1, 1), end: new Date(d.getFullYear(), d.getMonth(), 0) };
  }
  return { start: new Date(2000, 0, 1), end: d }; // "Всё время"
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

type RegisterSalesRow = {
  registerId: string;
  name: string;
  store: string | null;
  revenue: number;
  receipts: number;
  items: number;
  cost: number | null;
  returnedAmount: number;
  returnedReceipts: number;
  returnedItems: number;
};

// revenue/receipts/items on a row are already net of returns. "Gross" adds
// the returned amounts back — "what it looked like before the return came
// in" — purely for display; nothing that sums across rows elsewhere in the
// app ever uses this, only this page's own toggle.
function grossOf<T extends { revenue: number; receipts: number; items: number; returnedAmount: number; returnedReceipts: number; returnedItems: number }>(
  r: T
) {
  return {
    revenue: r.revenue + r.returnedAmount,
    receipts: r.receipts + r.returnedReceipts,
    items: r.items + r.returnedItems,
  };
}

export default function SalesPage() {
  const { isAdmin, permissions, stores } = useAuth();
  const { selected: selectedStores } = useStoreSelection();
  const canView = isAdmin || permissions["marketing.statistics"].canView;

  const [periodIndex, setPeriodIndex] = useState(DEFAULT_PERIOD);
  const [activeCustom, setActiveCustom] = useState<{ start: string; end: string } | null>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customPickerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerSales, setRegisterSales] = useState<RegisterSalesRow[]>([]);
  const [showGross, setShowGross] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = activeCustom
        ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
        : getPeriodRange(periodIndex, new Date());
      const { data, error: registerError } = await supabase
        .from("moysklad_sales_daily")
        .select(
          "register_id, revenue, receipts_count, items_count, cost, returned_amount, returned_receipts, returned_items, moysklad_registers(name, store)"
        )
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
        returnedAmount: number;
        returnedReceipts: number;
        returnedItems: number;
      };
      const byRegister = new Map<string, Agg>();
      for (const row of (data ?? []) as unknown as {
        register_id: string;
        revenue: number;
        receipts_count: number;
        items_count: number;
        cost: number | null;
        returned_amount: number | null;
        returned_receipts: number | null;
        returned_items: number | null;
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
          returnedAmount: 0,
          returnedReceipts: 0,
          returnedItems: 0,
        };
        agg.revenue += row.revenue ?? 0;
        agg.receipts += row.receipts_count ?? 0;
        agg.items += row.items_count ?? 0;
        agg.returnedAmount += row.returned_amount ?? 0;
        agg.returnedReceipts += row.returned_receipts ?? 0;
        agg.returnedItems += row.returned_items ?? 0;
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
          returnedAmount: a.returnedAmount,
          returnedReceipts: a.returnedReceipts,
          returnedItems: a.returnedItems,
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
        <p className="text-sm text-muted">У вас нет доступа к разделу «Продажа».</p>
      </div>
    );
  }

  // revenue/receipts/items on each row are already net of returns; when
  // showGross is on, this adds the returned amounts back for display only —
  // every sum here and below is derived from this, so nothing outside this
  // page (Статистика, KPIs, etc.) is ever affected by the toggle.
  function displayed(r: RegisterSalesRow) {
    return showGross ? grossOf(r) : { revenue: r.revenue, receipts: r.receipts, items: r.items };
  }

  const totalRevenue = registerSales.reduce((acc, r) => acc + displayed(r).revenue, 0);
  const totalReceipts = registerSales.reduce((acc, r) => acc + displayed(r).receipts, 0);
  const totalItems = registerSales.reduce((acc, r) => acc + displayed(r).items, 0);
  const totalReturned = {
    returnedAmount: registerSales.reduce((acc, r) => acc + r.returnedAmount, 0),
    returnedReceipts: registerSales.reduce((acc, r) => acc + r.returnedReceipts, 0),
    returnedItems: registerSales.reduce((acc, r) => acc + r.returnedItems, 0),
  };

  // "0" when nothing was returned; otherwise a compact "sum · N чек · N тов."
  function returnSummary(r: { returnedAmount: number; returnedReceipts: number; returnedItems: number }): string {
    if (r.returnedAmount === 0 && r.returnedReceipts === 0 && r.returnedItems === 0) return "0";
    const parts = [money(r.returnedAmount)];
    if (r.returnedReceipts > 0) parts.push(`${r.returnedReceipts} чек`);
    if (r.returnedItems > 0) parts.push(`${r.returnedItems} тов.`);
    return parts.join(" · ");
  }

  // A missing cost anywhere in the set makes the whole sum's gross profit
  // unknown, rather than silently treating it as zero.
  function sumCost(rows: RegisterSalesRow[]): number | null {
    let sum = 0;
    for (const r of rows) {
      if (r.cost === null) return null;
      sum += r.cost;
    }
    return sum;
  }
  function grossProfit(revenue: number, cost: number | null): string {
    return cost !== null ? money(revenue - cost) : "—";
  }
  const totalCost = sumCost(registerSales);

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
          в реальном времени. Возврат вычитается из дня, когда он произошёл: сумма и товар — всегда,
          а сам чек — если в нём был только один товар.
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

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[15px] font-bold">
            Продажи по кассам{" "}
            <span className="text-muted font-normal text-[12.5px]">
              ({showGross ? "без учёта возврата" : "с учётом возврата"})
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowGross((v) => !v)}
            className="text-[12.5px] font-semibold text-muted px-3 py-1.5 rounded-md border border-border hover:bg-paper"
          >
            {showGross ? "Учитывать возврат" : "Без учёта возврата"}
          </button>
        </div>
        {loading ? (
          <div className="text-sm text-muted py-4">Загрузка…</div>
        ) : registerSales.length === 0 ? (
          <div className="text-sm text-muted py-4">Нет данных за этот период.</div>
        ) : (
          <>
            <div className="grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Касса</div>
              <div>Город</div>
              <div>Выручка</div>
              <div>Чеков</div>
              <div>Средний чек</div>
              <div>Кол-во товара</div>
              <div>Глубина чека</div>
              <div>Вал. прибыль</div>
              <div>Возврат</div>
            </div>
            {visibleGroups.map((group) => {
              const groupRevenue = group.rows.reduce((acc, r) => acc + displayed(r).revenue, 0);
              const groupReceipts = group.rows.reduce((acc, r) => acc + displayed(r).receipts, 0);
              const groupItems = group.rows.reduce((acc, r) => acc + displayed(r).items, 0);
              const groupReturned = {
                returnedAmount: group.rows.reduce((acc, r) => acc + r.returnedAmount, 0),
                returnedReceipts: group.rows.reduce((acc, r) => acc + r.returnedReceipts, 0),
                returnedItems: group.rows.reduce((acc, r) => acc + r.returnedItems, 0),
              };
              const groupCost = sumCost(group.rows);
              return (
                <div key={group.store ?? "none"}>
                  {group.rows.map((r) => {
                    const d = displayed(r);
                    const avgCheck = d.receipts > 0 ? d.revenue / d.receipts : 0;
                    const checkDepth = d.receipts > 0 ? d.items / d.receipts : 0;
                    return (
                      <div
                        key={r.registerId}
                        className="grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
                      >
                        <div className="font-semibold">{r.name}</div>
                        <div className="text-muted">{storeLabel(r.store)}</div>
                        <div className="num">
                          {money(d.revenue)}
                          {!showGross && r.returnedAmount > 0 && (
                            <span className="text-mutedLight"> ({money(r.returnedAmount)})</span>
                          )}
                        </div>
                        <div className="num">
                          {d.receipts}
                          {!showGross && r.returnedReceipts > 0 && (
                            <span className="text-mutedLight"> ({r.returnedReceipts})</span>
                          )}
                        </div>
                        <div className="num">{money(avgCheck)}</div>
                        <div className="num">
                          {d.items.toLocaleString("ru-RU")}
                          {!showGross && r.returnedItems > 0 && (
                            <span className="text-mutedLight"> ({r.returnedItems})</span>
                          )}
                        </div>
                        <div className="num">{checkDepth.toFixed(3)}</div>
                        <div className="num">{grossProfit(d.revenue, r.cost)}</div>
                        <div className="num text-muted">{returnSummary(r)}</div>
                      </div>
                    );
                  })}
                  {group.rows.length > 1 && (
                    <div className="grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 py-2 border-b border-borderSoft items-center text-[12.5px] font-bold bg-weekendTint">
                      <div className="col-span-2">Итого по {group.label}</div>
                      <div className="num">
                        {money(groupRevenue)}
                        {!showGross && groupReturned.returnedAmount > 0 && (
                          <span className="text-mutedLight font-normal"> ({money(groupReturned.returnedAmount)})</span>
                        )}
                      </div>
                      <div className="num">
                        {groupReceipts}
                        {!showGross && groupReturned.returnedReceipts > 0 && (
                          <span className="text-mutedLight font-normal"> ({groupReturned.returnedReceipts})</span>
                        )}
                      </div>
                      <div className="num">{groupReceipts > 0 ? money(groupRevenue / groupReceipts) : "—"}</div>
                      <div className="num">
                        {groupItems.toLocaleString("ru-RU")}
                        {!showGross && groupReturned.returnedItems > 0 && (
                          <span className="text-mutedLight font-normal"> ({groupReturned.returnedItems})</span>
                        )}
                      </div>
                      <div className="num">{groupReceipts > 0 ? (groupItems / groupReceipts).toFixed(3) : "—"}</div>
                      <div className="num">{grossProfit(groupRevenue, groupCost)}</div>
                      <div className="num text-muted font-normal">{returnSummary(groupReturned)}</div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 pt-2.5 border-t-2 border-[#E4DFC8] text-[13px] font-bold">
              <div className="col-span-2">Итого</div>
              <div className="num">
                {money(totalRevenue)}
                {!showGross && totalReturned.returnedAmount > 0 && (
                  <span className="text-mutedLight font-normal"> ({money(totalReturned.returnedAmount)})</span>
                )}
              </div>
              <div className="num">
                {totalReceipts}
                {!showGross && totalReturned.returnedReceipts > 0 && (
                  <span className="text-mutedLight font-normal"> ({totalReturned.returnedReceipts})</span>
                )}
              </div>
              <div className="num">{totalReceipts > 0 ? money(totalRevenue / totalReceipts) : "—"}</div>
              <div className="num">
                {totalItems.toLocaleString("ru-RU")}
                {!showGross && totalReturned.returnedItems > 0 && (
                  <span className="text-mutedLight font-normal"> ({totalReturned.returnedItems})</span>
                )}
              </div>
              <div className="num">{totalReceipts > 0 ? (totalItems / totalReceipts).toFixed(3) : "—"}</div>
              <div className="num">{grossProfit(totalRevenue, totalCost)}</div>
              <div className="num text-muted font-normal">{returnSummary(totalReturned)}</div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
