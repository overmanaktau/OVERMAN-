// Ежедневный снимок остатков (себестоимость и розничная стоимость по складу и верхней
// категории) — из него оборачиваемость считается по СРЕДНЕМУ остатку за период, а не по
// остатку на сегодня. История восстанавливается задним числом: отчёты МойСклад «остатки»
// умеют отдавать остатки на любой момент (filter=moment=…), цены берутся из самого отчёта
// на тот же момент.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchStockAll, fetchStockByStore } from "@/lib/moysklad";
import { WAREHOUSE_STORE } from "@/lib/warehouses";

type SnapshotRow = {
  snapshot_date: string;
  store: string;
  top_category: string;
  stock_value: number;
  stock_sale_value: number;
  items: number;
};

// Остатки на конец дня `date` (23:59:59 по времени МойСклад), сохраняем по складу и категории.
// Возвращает число сохранённых строк. Повторный запуск за ту же дату перезаписывает её снимок.
export async function snapshotStockForDate(date: string): Promise<number> {
  const moment = `${date} 23:59:59`;
  // По очереди: МойСклад отвечает 429, если запросов слишком много сразу.
  const all = await fetchStockAll(moment);
  const byStore = await fetchStockByStore(moment);
  const info = new Map(all.map((s) => [s.productMsId, s]));

  const agg = new Map<string, SnapshotRow>();
  for (const row of byStore) {
    const store = WAREHOUSE_STORE[row.warehouseId];
    const p = info.get(row.productMsId);
    if (!store || !p || row.stock <= 0 || p.buyPrice === null) continue;
    const category = p.topCategory ?? "Без категории";
    const key = `${store}|${category}`;
    const a = agg.get(key) ?? { snapshot_date: date, store, top_category: category, stock_value: 0, stock_sale_value: 0, items: 0 };
    a.stock_value += row.stock * p.buyPrice;
    a.stock_sale_value += row.stock * (p.salePrice ?? 0);
    a.items += row.stock;
    agg.set(key, a);
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
