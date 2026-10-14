// Остатки склада из МойСклад → таблицы портала. Общий код ночной синхронизации (app/api/moysklad/sync) и частого обновления
// остатков в течение дня (app/api/moysklad/stock-refresh): остатки по каждому складу берутся отчётом «Остатки» по складу
// (как на экране МойСклад — у каждого склада своя себестоимость), плюсовые идут в moysklad_product_stock, минусовые — в
// moysklad_product_stock_negative (нужны только для итогов «как в МойСклад»).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deriveArticle, fetchStockAll } from "@/lib/moysklad";
import { WAREHOUSE_STORE } from "@/lib/warehouses";

export type StockReportRows = Awaited<ReturnType<typeof fetchStockAll>>;
export type WarehouseStock = { warehouseId: string; store: string; rows: StockReportRows };

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// По очереди: МойСклад отвечает 429, если запросов слишком много сразу.
export async function fetchStockByWarehouses(): Promise<WarehouseStock[]> {
  const out: WarehouseStock[] = [];
  for (const [warehouseId, store] of Object.entries(WAREHOUSE_STORE)) {
    out.push({ warehouseId, store, rows: await fetchStockAll(undefined, warehouseId) });
  }
  return out;
}

type Agg = { productMsId: string; store: string; name: string; category: string | null; topCategory: string | null; stock: number; posStock: number; posCost: number; fallbackPrice: number | null; salePrice: number | null; stockDays: number | null };

export function aggregateStock(byWarehouse: WarehouseStock[], now: string) {
  const byStock = new Map<string, Agg>();
  for (const w of byWarehouse) {
    for (const r of w.rows) {
      if (!r.stock) continue;
      const key = `${r.productMsId}|${w.store}`;
      const a = byStock.get(key) ?? { productMsId: r.productMsId, store: w.store, name: r.name, category: r.category, topCategory: r.topCategory, stock: 0, posStock: 0, posCost: 0, fallbackPrice: r.buyPrice, salePrice: r.salePrice, stockDays: r.stockDays };
      a.stock += r.stock;
      if (r.stock > 0) {
        a.posStock += r.stock;
        a.posCost += r.stock * (r.buyPrice ?? 0);
      }
      if (a.stockDays === null || (r.stockDays ?? -1) > a.stockDays) a.stockDays = r.stockDays;
      byStock.set(key, a);
    }
  }
  // плюсовые остатки — в основную таблицу; минусовые — отдельно (для итогов «как в МойСклад»)
  const stockRows = [...byStock.values()]
    .filter((a) => a.stock > 0)
    .map((a) => ({
      product_ms_id: a.productMsId,
      product_name: a.name,
      category: a.category,
      top_category: a.topCategory,
      store: a.store,
      stock: a.stock,
      // себестоимость единицы на этом складе (если склад заменяет несколько — средневзвешенная)
      buy_price: a.posStock > 0 ? a.posCost / a.posStock : a.fallbackPrice,
      sale_price: a.salePrice,
      stock_days: a.stockDays,
      synced_at: now,
    }));
  const negativeRows = [...byStock.values()]
    .filter((a) => a.stock < 0)
    .map((a) => ({ product_ms_id: a.productMsId, store: a.store, product_name: a.name, stock: a.stock, sale_price: a.salePrice, synced_at: now }));
  return { stockRows, negativeRows };
}

type StockRow = ReturnType<typeof aggregateStock>["stockRows"][number];
type NegativeRow = ReturnType<typeof aggregateStock>["negativeRows"][number];

// Записывает остатки. Таблица остатков хранит только позиции с остатком больше нуля: всё, что распродано или переехало,
// удаляется. Защита: если пришло подозрительно мало строк (сбой отчёта), ничего не удаляем. Возвращает, сколько строк удалено.
export async function writeStock(stockRows: StockRow[], negativeRows: NegativeRow[], now: string): Promise<number> {
  for (const batch of chunk(stockRows, 500)) {
    const { error } = await supabaseAdmin.from("moysklad_product_stock").upsert(batch, { onConflict: "product_ms_id,store" });
    if (error) throw error;
  }
  // минусовые позиции пересобираем целиком: то, что перестало быть минусом, из таблицы уходит
  if (stockRows.length >= 500) {
    const { error: delNegError } = await supabaseAdmin.from("moysklad_product_stock_negative").delete().lt("synced_at", now);
    if (delNegError) throw delNegError;
  }
  for (const batch of chunk(negativeRows, 500)) {
    const { error } = await supabaseAdmin.from("moysklad_product_stock_negative").upsert(batch, { onConflict: "product_ms_id,store" });
    if (error) throw error;
  }

  let staleRemoved = 0;
  if (stockRows.length >= 500) {
    const live = new Set(stockRows.map((r) => `${r.product_ms_id}|${r.store}`));
    const tracked = new Set(Object.values(WAREHOUSE_STORE));
    const stale: { product_ms_id: string; store: string }[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabaseAdmin
        .from("moysklad_product_stock")
        .select("product_ms_id, store")
        .order("product_ms_id")
        .order("store")
        .range(offset, offset + 999);
      if (error) throw error;
      for (const r of (data ?? []) as { product_ms_id: string; store: string }[]) {
        if (tracked.has(r.store) && !live.has(`${r.product_ms_id}|${r.store}`)) stale.push(r);
      }
      if (!data || data.length < 1000) break;
    }
    const byStore = new Map<string, string[]>();
    for (const r of stale) byStore.set(r.store, [...(byStore.get(r.store) ?? []), r.product_ms_id]);
    for (const [store, ids] of byStore) {
      for (const batch of chunk(ids, 200)) {
        const { error } = await supabaseAdmin.from("moysklad_product_stock").delete().eq("store", store).in("product_ms_id", batch);
        if (error) throw error;
      }
    }
    staleRemoved = stale.length;
  }
  return staleRemoved;
}

// Частое обновление остатков в течение дня: только остатки (без каталога и приёмок). Новые позиции, которых ещё нет в каталоге
// (например, заведены сегодня), заводятся в каталог по данным отчёта — полные данные (поставщик) подтянет ночная синхронизация.
export async function refreshStockOnly(): Promise<{ stockRows: number; negativeRows: number; staleRemoved: number; catalogAdded: number }> {
  const now = new Date().toISOString();
  const byWarehouse = await fetchStockByWarehouses();
  const info = new Map<string, StockReportRows[number]>();
  for (const w of byWarehouse) for (const r of w.rows) if (r.stock && !info.has(r.productMsId)) info.set(r.productMsId, r);

  const known = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.from("moysklad_products").select("id").order("id").range(offset, offset + 999);
    if (error) throw error;
    for (const r of data ?? []) known.add(r.id as string);
    if (!data || data.length < 1000) break;
  }
  const missing = [...info.entries()].filter(([id]) => !known.has(id));
  for (const batch of chunk(missing, 500)) {
    const { error } = await supabaseAdmin.from("moysklad_products").upsert(
      batch.map(([id, r]) => ({
        id,
        name: r.name,
        category: r.category,
        top_category: r.topCategory,
        buy_price: r.buyPrice,
        archived: false,
        image_url: r.imageUrl,
        image_full_href: r.imageFullHref,
        article: deriveArticle(r.name),
        supplier: null,
        synced_at: now,
      })),
      { onConflict: "id" }
    );
    if (error) throw error;
  }

  const { stockRows, negativeRows } = aggregateStock(byWarehouse, now);
  const staleRemoved = await writeStock(stockRows, negativeRows, now);
  return { stockRows: stockRows.length, negativeRows: negativeRows.length, staleRemoved, catalogAdded: missing.length };
}
