"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useSiteVersion } from "@/components/SiteVersion";
import { useStoreSelection } from "@/components/StoreSelection";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

// Products currently in stock with zero recorded sales in this many days —
// computed from our own synced sales history (moysklad_product_sales_daily),
// not МойСклад's "оборачиваемость" metric, which measures days-of-supply at
// the recent sales pace and can stay low even for something that hasn't
// actually sold in months. Threshold matches the page's own title; not
// user-adjustable.
const STALE_DAYS = 60;

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

type StaleRow = {
  id: string;
  name: string;
  stock: number;
  money: number; // at cost (себестоимость)
  saleValue: number; // at retail (цена продажи)
  daysSinceLastSale: number | null; // null = no recorded sale at all in our synced history
};

// Paginates past PostgREST's default row cap — this list alone can run into
// the thousands (every slow-moving SKU across the whole catalog).
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const pageSize = 1000;
  let offset = 0;
  const all: T[] = [];
  for (;;) {
    const { data, error } = await build(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

type StaleRawRow = {
  product_ms_id: string;
  product_name: string;
  stock: number;
  money: number;
  sale_value: number;
  days_since_last_sale: number | null;
};

function mapStaleRows(raw: StaleRawRow[]): StaleRow[] {
  return raw
    .map((r) => ({
      id: r.product_ms_id,
      name: r.product_name,
      stock: r.stock,
      money: r.money,
      saleValue: r.sale_value,
      daysSinceLastSale: r.days_since_last_sale,
    }))
    .sort((a, b) => b.money - a.money);
}

function StaleTable({ rows, mobileLayout, emptyText }: { rows: StaleRow[]; mobileLayout: boolean; emptyText: string }) {
  if (rows.length === 0) return <div className="text-sm text-muted py-4">{emptyText}</div>;
  if (mobileLayout) {
    return (
      <div className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px]">
            <div className="font-semibold">{r.name}</div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Остаток</span>
              <span className="num">{r.stock.toLocaleString("ru-RU")}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Деньги (себестоимость)</span>
              <span className="num">{money(r.money)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">По цене продажи</span>
              <span className="num">{money(r.saleValue)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Без продаж</span>
              <span className="num">{r.daysSinceLastSale === null ? "не продавался" : `${r.daysSinceLastSale} дн.`}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px] grid grid-cols-[1.6fr_0.6fr_0.9fr_0.9fr_1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
        <div>Товар</div>
        <div>Остаток</div>
        <div>Деньги (себест.)</div>
        <div>По цене продажи</div>
        <div>Без продаж</div>
      </div>
      {rows.map((r) => (
        <div
          key={r.id}
          className="min-w-[800px] grid grid-cols-[1.6fr_0.6fr_0.9fr_0.9fr_1fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
        >
          <div className="font-semibold">{r.name}</div>
          <div className="num">{r.stock.toLocaleString("ru-RU")}</div>
          <div className="num">{money(r.money)}</div>
          <div className="num text-muted">{money(r.saleValue)}</div>
          <div className="num text-muted">{r.daysSinceLastSale === null ? "не продавался" : `${r.daysSinceLastSale} дн.`}</div>
        </div>
      ))}
    </div>
  );
}

export default function StaleInventoryPage() {
  const { isAdmin, permissions } = useAuth();
  const { mobileLayout } = useSiteVersion();
  const { selected: selectedStores } = useStoreSelection();
  const canView = isAdmin || permissions["warehouse.stock"].canView;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<StaleRow[]>([]);
  // "Заморозка" (written-off-for-now stock, held back for next season) is
  // its own bucket the business tracks on purpose — always shown, never
  // folded into the city-filtered list above or affected by "Все города".
  const [frozenRows, setFrozenRows] = useState<StaleRow[]>([]);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [raw, rawFrozen] = await Promise.all([
        fetchAllRows<StaleRawRow>((from, to) =>
          supabase
            .rpc("stale_inventory", { p_stale_days: STALE_DAYS, p_stores: selectedStores })
            .order("product_ms_id", { ascending: true })
            .range(from, to)
        ),
        // -1 rather than STALE_DAYS: "заморозка" isn't about staleness, it's
        // stock the business deliberately set aside — show all of it, not
        // just what's also been sitting 60+ days. (current_date - last_sale)
        // is never negative, so "> -1" always passes.
        fetchAllRows<StaleRawRow>((from, to) =>
          supabase
            .rpc("stale_inventory", { p_stale_days: -1, p_stores: ["frozen"] })
            .order("product_ms_id", { ascending: true })
            .range(from, to)
        ),
      ]);

      if (seq !== loadSeq.current) return;
      setRows(mapStaleRows(raw));
      setFrozenRows(mapStaleRows(rawFrozen));
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setRows([]);
      setFrozenRows([]);
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
        <p className="text-sm text-muted">У вас нет доступа к разделу «Склад».</p>
      </div>
    );
  }

  const totalMoney = rows.reduce((acc, r) => acc + r.money, 0);
  const totalSaleValue = rows.reduce((acc, r) => acc + r.saleValue, 0);
  const totalFrozenMoney = frozenRows.reduce((acc, r) => acc + r.money, 0);
  const totalFrozenSaleValue = frozenRows.reduce((acc, r) => acc + r.saleValue, 0);

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Склад</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Зависшие остатки</h1>
        <p className="text-sm text-muted max-w-2xl mt-1">
          Товары в наличии, которые не продавались {STALE_DAYS}+ дней (или ни разу за всё время
          синхронизации).
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
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Зависло дольше {STALE_DAYS} дней</div>
              <div className="font-serif text-[26px] font-semibold num">{rows.length.toLocaleString("ru-RU")} моделей</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Денег в них (себестоимость)</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalMoney)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">По цене продажи</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalSaleValue)}</div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <StaleTable rows={rows} mobileLayout={mobileLayout} emptyText="Нет зависших остатков — всё продаётся вовремя." />
          </div>

          <div className="flex flex-col gap-1 mt-2">
            <h2 className="font-serif text-[20px] font-semibold m-0">Заморозка</h2>
            <p className="text-sm text-muted max-w-2xl">
              Товар на складах заморозки — отдельно от городов, ждёт следующего сезона.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Моделей в заморозке</div>
              <div className="font-serif text-[26px] font-semibold num">{frozenRows.length.toLocaleString("ru-RU")}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Денег в них (себестоимость)</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalFrozenMoney)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">По цене продажи</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalFrozenSaleValue)}</div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <StaleTable rows={frozenRows} mobileLayout={mobileLayout} emptyText="В заморозке ничего нет." />
          </div>
        </>
      )}
    </>
  );
}
