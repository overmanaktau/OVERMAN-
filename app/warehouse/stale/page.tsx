"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useSiteVersion } from "@/components/SiteVersion";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

// МойСклад's own "оборачиваемость, дней" (stockDays) — how long the current
// stock of an item has been sitting without moving. Threshold matches the
// page's own title; not user-adjustable.
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
  money: number;
  stockDays: number;
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

export default function StaleInventoryPage() {
  const { isAdmin, permissions } = useAuth();
  const { mobileLayout } = useSiteVersion();
  const canView = isAdmin || permissions["warehouse.stock"].canView;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<StaleRow[]>([]);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      type Raw = { product_ms_id: string; product_name: string; stock: number; buy_price: number | null; stock_days: number | null };
      const raw = await fetchAllRows<Raw>((from, to) =>
        supabase
          .from("moysklad_product_stock")
          .select("product_ms_id, product_name, stock, buy_price, stock_days")
          .gt("stock", 0)
          .gt("stock_days", STALE_DAYS)
          .order("product_ms_id", { ascending: true })
          .range(from, to)
      );

      const mapped: StaleRow[] = raw
        .map((r) => ({
          id: r.product_ms_id,
          name: r.product_name,
          stock: r.stock,
          money: r.stock * (r.buy_price ?? 0),
          stockDays: r.stock_days ?? 0,
        }))
        .sort((a, b) => b.money - a.money);

      if (seq !== loadSeq.current) return;
      setRows(mapped);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setRows([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

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

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Склад</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Зависшие остатки</h1>
        <p className="text-sm text-muted max-w-2xl mt-1">
          Товары, которые лежат на складе дольше {STALE_DAYS} дней без движения — по данным
          МойСклад («оборачиваемость, дней»).
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
          <div className="grid grid-cols-2 sm:grid-cols-2 gap-4 max-w-xl">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Зависло дольше {STALE_DAYS} дней</div>
              <div className="font-serif text-[26px] font-semibold num">{rows.length.toLocaleString("ru-RU")} моделей</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Денег в них</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalMoney)}</div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            {rows.length === 0 ? (
              <div className="text-sm text-muted py-4">Нет зависших остатков — всё продаётся вовремя.</div>
            ) : mobileLayout ? (
              <div className="flex flex-col gap-3">
                {rows.map((r) => (
                  <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px]">
                    <div className="font-semibold">{r.name}</div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Остаток</span>
                      <span className="num">{r.stock.toLocaleString("ru-RU")}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Деньги</span>
                      <span className="num">{money(r.money)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[560px] grid grid-cols-[1.6fr_0.6fr_0.9fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                  <div>Товар</div>
                  <div>Остаток</div>
                  <div>Деньги</div>
                </div>
                {rows.map((r) => (
                  <div
                    key={r.id}
                    className="min-w-[560px] grid grid-cols-[1.6fr_0.6fr_0.9fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
                  >
                    <div className="font-semibold">{r.name}</div>
                    <div className="num">{r.stock.toLocaleString("ru-RU")}</div>
                    <div className="num">{money(r.money)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
