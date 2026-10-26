// Ежедневный снимок остатков (себестоимость и розничная стоимость по складу и верхней
// категории) — из него оборачиваемость считается по СРЕДНЕМУ остатку за период, а не по
// остатку на сегодня. История восстанавливается задним числом: отчёты МойСклад «остатки»
// умеют отдавать остатки на любой момент (filter=moment=…), цены берутся из самого отчёта
// на тот же момент.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchStockAll } from "@/lib/moysklad";
import { WAREHOUSE_STORE } from "@/lib/warehouses";
import { BUYER_STORES } from "@/lib/reports/buyerStores";

type SnapshotRow = {
  snapshot_date: string;
  store: string;
  top_category: string;
  stock_value: number;
  stock_sale_value: number;
  items: number;
};

// Поставщик каждого товара из каталога портала (пустой — «Без поставщика»).
async function loadSupplierMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.from("moysklad_products").select("id, supplier").order("id").range(offset, offset + 999);
    if (error) throw error;
    for (const r of data ?? []) map.set(r.id as string, ((r.supplier as string | null)?.trim() || "Без поставщика"));
    if (!data || data.length < 1000) break;
  }
  return map;
}

// Остатки по каждому товару на конец дня (штуки) — только два основных склада, только позиции с остатком не ноль (для отчёта закупщика).
type ProductSnapshotRow = { snapshot_date: string; store: string; product_ms_id: string; stock: number };
const PRODUCT_SNAPSHOT_STORES = new Set(BUYER_STORES.all);

async function saveProductSnapshot(date: string, rows: ProductSnapshotRow[]): Promise<number> {
  const { error: delError } = await supabaseAdmin.from("moysklad_stock_snapshot_product_daily").delete().eq("snapshot_date", date);
  if (delError) throw delError;
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabaseAdmin.from("moysklad_stock_snapshot_product_daily").insert(rows.slice(i, i + 1000));
    if (error) throw error;
  }
  return rows.length;
}

// Только снимок по товарам за дату (для восстановления истории: общие снимки по складам и поставщикам не трогаем).
export async function snapshotProductStockForDate(date: string): Promise<number> {
  const moment = `${date} 23:59:59`;
  const rows: ProductSnapshotRow[] = [];
  for (const [warehouseId, store] of Object.entries(WAREHOUSE_STORE)) {
    if (!PRODUCT_SNAPSHOT_STORES.has(store)) continue;
    const merged = new Map<string, number>();
    for (const p of await fetchStockAll(moment, warehouseId)) if (p.stock) merged.set(p.productMsId, (merged.get(p.productMsId) ?? 0) + p.stock);
    for (const [product_ms_id, stock] of merged) rows.push({ snapshot_date: date, store, product_ms_id, stock });
  }
  return saveProductSnapshot(date, rows);
}

// Остатки на конец дня `date` (23:59:59 по времени МойСклад), сохраняем по складу и категории.
// Возвращает число сохранённых строк. Повторный запуск за ту же дату перезаписывает её снимок.
export async function snapshotStockForDate(date: string): Promise<number> {
  const moment = `${date} 23:59:59`;
  const supplierOf = await loadSupplierMap();
  const agg = new Map<string, SnapshotRow>();
  const bySupplier = new Map<string, { snapshot_date: string; store: string; supplier: string; top_category: string; stock_value: number; items: number }>();
  const byProduct = new Map<string, ProductSnapshotRow>();

  // Отчёт «Остатки» по каждому складу отдельно (как на экране МойСклад): у каждого склада своя себестоимость единицы, а общий
  // отчёт «все склады» даёт одну среднюю цену. Позиции с минусом входят в штуки и сумму продажи (в МойСклад их себестоимость 0).
  // По очереди: МойСклад отвечает 429, если запросов слишком много сразу.
  for (const [warehouseId, store] of Object.entries(WAREHOUSE_STORE)) {
    const rows = await fetchStockAll(moment, warehouseId);
    for (const p of rows) {
      if (!p.stock) continue;
      if (PRODUCT_SNAPSHOT_STORES.has(store)) {
        const pk = `${store}|${p.productMsId}`;
        const pr = byProduct.get(pk);
        if (pr) pr.stock += p.stock;
        else byProduct.set(pk, { snapshot_date: date, store, product_ms_id: p.productMsId, stock: p.stock });
      }
      const cost = p.stock * (p.buyPrice ?? 0);
      const category = p.topCategory ?? "Без категории";
      const key = `${store}|${category}`;
      const a = agg.get(key) ?? { snapshot_date: date, store, top_category: category, stock_value: 0, stock_sale_value: 0, items: 0 };
      a.stock_value += cost;
      a.stock_sale_value += p.stock * (p.salePrice ?? 0);
      a.items += p.stock;
      agg.set(key, a);

      // то же по поставщикам и верхней категории (поставщик — из карточки товара в базе портала)
      const supplier = supplierOf.get(p.productMsId) ?? "Без поставщика";
      const skey = `${store}|${supplier}|${category}`;
      const sa = bySupplier.get(skey) ?? { snapshot_date: date, store, supplier, top_category: category, stock_value: 0, items: 0 };
      sa.stock_value += cost;
      sa.items += p.stock;
      bySupplier.set(skey, sa);
    }
  }
  const supplierRows = [...bySupplier.values()];
  const { error: delSupError } = await supabaseAdmin.from("moysklad_stock_snapshot_supplier_daily").delete().eq("snapshot_date", date);
  if (delSupError) throw delSupError;
  for (let i = 0; i < supplierRows.length; i += 500) {
    const { error } = await supabaseAdmin.from("moysklad_stock_snapshot_supplier_daily").insert(supplierRows.slice(i, i + 500));
    if (error) throw error;
  }

  const rows = [...agg.values()];
  const { error: delError } = await supabaseAdmin.from("moysklad_stock_snapshot_daily").delete().eq("snapshot_date", date);
  if (delError) throw delError;
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("moysklad_stock_snapshot_daily").insert(rows);
    if (error) throw error;
  }
  await saveProductSnapshot(date, [...byProduct.values()]);
  return rows.length;
}
