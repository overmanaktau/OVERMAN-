// Ежедневный снимок остатков (себестоимость и розничная стоимость по складу и верхней
// категории) — из него оборачиваемость считается по СРЕДНЕМУ остатку за период, а не по
// остатку на сегодня. История восстанавливается задним числом: отчёты МойСклад «остатки»
// умеют отдавать остатки на любой момент (filter=moment=…), цены берутся из самого отчёта
// на тот же момент.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchStockAll } from "@/lib/moysklad";
import { WAREHOUSE_STORE } from "@/lib/warehouses";

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

// Остатки на конец дня `date` (23:59:59 по времени МойСклад), сохраняем по складу и категории.
// Возвращает число сохранённых строк. Повторный запуск за ту же дату перезаписывает её снимок.
export async function snapshotStockForDate(date: string): Promise<number> {
  const moment = `${date} 23:59:59`;
  const supplierOf = await loadSupplierMap();
  const agg = new Map<string, SnapshotRow>();
  const bySupplier = new Map<string, { snapshot_date: string; store: string; supplier: string; stock_value: number; items: number }>();

  // Отчёт «Остатки» по каждому складу отдельно (как на экране МойСклад): у каждого склада своя себестоимость единицы, а общий
  // отчёт «все склады» даёт одну среднюю цену. Позиции с минусом входят в штуки и сумму продажи (в МойСклад их себестоимость 0).
  // По очереди: МойСклад отвечает 429, если запросов слишком много сразу.
  for (const [warehouseId, store] of Object.entries(WAREHOUSE_STORE)) {
    const rows = await fetchStockAll(moment, warehouseId);
    for (const p of rows) {
      if (!p.stock) continue;
      const cost = p.stock * (p.buyPrice ?? 0);
      const category = p.topCategory ?? "Без категории";
      const key = `${store}|${category}`;
      const a = agg.get(key) ?? { snapshot_date: date, store, top_category: category, stock_value: 0, stock_sale_value: 0, items: 0 };
      a.stock_value += cost;
      a.stock_sale_value += p.stock * (p.salePrice ?? 0);
      a.items += p.stock;
      agg.set(key, a);

      // то же по поставщикам (поставщик — из карточки товара в базе портала)
      const supplier = supplierOf.get(p.productMsId) ?? "Без поставщика";
      const skey = `${store}|${supplier}`;
      const sa = bySupplier.get(skey) ?? { snapshot_date: date, store, supplier, stock_value: 0, items: 0 };
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
  return rows.length;
}
