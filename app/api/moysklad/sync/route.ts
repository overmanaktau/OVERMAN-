import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";

// Without this, Vercel caps the function at its platform default (well
// under a minute) — this route now does a full catalog/stock/supply resync
// plus one profit-report call per склад, every single invocation, which
// can run past that on its own. 300s is the max Vercel honors outside
// Enterprise; it silently clamps down further on lower plans, so this is a
// ceiling request, not a guarantee.
export const maxDuration = 300;
import {
  fetchRetailDemandsForDate,
  fetchRetailSalesReturnsForDate,
  fetchDemandInfo,
  fetchReturnedItemsBefore,
  totalCostKopecks,
  fetchAllProducts,
  fetchStockAll,
  fetchStockByStore,
  fetchAllSupplies,
  fetchProfitByProductForDate,
  deriveArticle,
} from "@/lib/moysklad";
import { WAREHOUSE_STORE } from "@/lib/warehouses";
import { REGISTER_STORE, SAYA_PARK_REGISTER_ID, SAYA_PARK_RETIRED_FROM, SAYA_PARK_WAREHOUSE_ID } from "@/lib/registers";
import { snapshotStockForDate } from "@/lib/stockSnapshot";

// (карта касс REGISTER_STORE и константы Saya Park теперь в lib/registers.ts — общие для синхронизации и сверки)

// Warehouses (entity/store — where stock physically sits, distinct from the
// retailstore/касса ids above) — unlike REGISTER_STORE, this maps to a code
// per real warehouse (not collapsed to city), since Зависшие остатки/АВС-XYZ
// filter by real склад directly. lib/warehouses.ts holds the matching
// code→label→city map the frontend uses to build that filter and to
// restrict it by a role's city access — keep the two in sync by hand.
// Confirmed with the business owner: "Кайнар" is empty and not worth
// tracking, so it (and anything else not listed here) is simply skipped by
// the sync. The two "заморозка"/frozen warehouses hold written-off-for-now
// stock the business tracks on purpose as its own bucket, held back until
// next season — never folded into a city's live total. Saya Park and
// Актобе скидка stay here even though their registers are archived above —
// this map is about physical stock location, not active points of sale.
// (карта WAREHOUSE_STORE теперь в lib/warehouses.ts — общая для синхронизации и снимков остатков)

function yesterdayInAlmaty(): string {
  // Kazakhstan runs on a single UTC+5 zone (Asia/Almaty covers it, no DST) —
  // the server itself runs in UTC, so "yesterday" has to be computed in
  // that local zone, not the server's own date.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const localToday = new Date(Date.UTC(y, m - 1, d));
  localToday.setUTCDate(localToday.getUTCDate() - 1);
  return localToday.toISOString().slice(0, 10);
}

async function runSync(date: string) {
  const [demands, returns] = await Promise.all([
    fetchRetailDemandsForDate(date),
    fetchRetailSalesReturnsForDate(date),
  ]);

  type RegisterAgg = {
    name: string;
    revenue: number;
    receipts: number;
    items: number;
    cost: number;
    returnedAmount: number;
    returnedReceipts: number;
    returnedItems: number;
  };
  type EmployeeAgg = RegisterAgg & { store: string };
  const byRegister = new Map<string, RegisterAgg>();
  // Keyed by `${employeeId}|${store}` — an employee normally sells at one
  // store, but keeping store in the key means a rare cross-store shift
  // shows up as two honest rows instead of getting attributed to whichever
  // store happened to sync last.
  const byEmployee = new Map<string, EmployeeAgg>();
  function emptyAgg(): RegisterAgg {
    return { name: "", revenue: 0, receipts: 0, items: 0, cost: 0, returnedAmount: 0, returnedReceipts: 0, returnedItems: 0 };
  }
  for (const d of demands) {
    const id = d.retailStore?.id;
    const name = d.retailStore?.name;
    if (!id || !name || !REGISTER_STORE[id]) continue; // not a live retail register
    if (id === SAYA_PARK_REGISTER_ID && date >= SAYA_PARK_RETIRED_FROM) continue;
    const agg = byRegister.get(id) ?? { ...emptyAgg(), name };
    agg.revenue += (d.sum ?? 0) / 100;
    agg.receipts += 1;
    agg.items += (d.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
    agg.cost += totalCostKopecks(d.positions?.rows) / 100;
    byRegister.set(id, agg);

    const employeeId = d.owner?.id;
    const employeeName = d.owner?.name;
    if (employeeId && employeeName) {
      const store = REGISTER_STORE[id];
      const key = `${employeeId}|${store}`;
      const eAgg = byEmployee.get(key) ?? { ...emptyAgg(), name: employeeName, store };
      eAgg.revenue += (d.sum ?? 0) / 100;
      eAgg.receipts += 1;
      eAgg.items += (d.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
      eAgg.cost += totalCostKopecks(d.positions?.rows) / 100;
      byEmployee.set(key, eAgg);
    }
  }

  // A return always subtracts from the day it happened on, not the day of
  // the original sale — today's return reduces today's numbers, period. It
  // also voids the receipt itself (receipts_count -1) when the whole original
  // check came back (a single-item check, or a multi-item check returned in
  // full), since there's no completed sale left; a return of only part of a
  // multi-item check just shrinks that receipt, it doesn't void it.
  // Counts are shown as they are, not clamped at zero: a return of a sale
  // made on an earlier day leaves a negative number for the return day.
  // returnedAmount/returnedReceipts/returnedItems are kept alongside so the
  // UI can show both the final (already-netted) figure and, next to it, how
  // much of it was returns.
  let returnedAmount = 0;
  let voidedReceipts = 0;
  for (const r of returns) {
    const id = r.retailStore?.id;
    const name = r.retailStore?.name;
    if (!id || !name || !REGISTER_STORE[id]) continue;
    if (id === SAYA_PARK_REGISTER_ID && date >= SAYA_PARK_RETIRED_FROM) continue;
    const agg = byRegister.get(id) ?? { ...emptyAgg(), name };
    const rSum = (r.sum ?? 0) / 100;
    const rItems = (r.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
    agg.revenue -= rSum;
    agg.items -= rItems;
    agg.cost -= totalCostKopecks(r.positions?.rows) / 100;
    agg.returnedAmount += rSum;
    agg.returnedItems += rItems;
    returnedAmount += rSum;

    let voidedThisReturn = false;
    const demandHref = r.demand?.meta?.href;
    if (demandHref) {
      const { items: originalItemCount, moment: demandMoment } = await fetchDemandInfo(demandHref);
      // Чек аннулируется, если вернули всё, что в нём было: чек из одного товара или любой
      // чек, вернувшийся целиком (вернули столько товаров, сколько в нём было). Если чек
      // возвращали по частям — несколькими документами и даже в разные дни, — он аннулируется
      // на том возврате, которым вернули последний товар (считаем всё, что вернули раньше).
      const returnedBefore = await fetchReturnedItemsBefore(demandHref, demandMoment, r);
      if (originalItemCount > 0 && returnedBefore < originalItemCount && returnedBefore + rItems >= originalItemCount) {
        agg.receipts -= 1;
        agg.returnedReceipts += 1;
        voidedReceipts += 1;
        voidedThisReturn = true;
      }
    }
    byRegister.set(id, agg);

    const employeeId = r.owner?.id;
    const employeeName = r.owner?.name;
    if (employeeId && employeeName) {
      const store = REGISTER_STORE[id];
      const key = `${employeeId}|${store}`;
      const eAgg = byEmployee.get(key) ?? { ...emptyAgg(), name: employeeName, store };
      eAgg.revenue -= rSum;
      eAgg.items -= rItems;
      eAgg.cost -= totalCostKopecks(r.positions?.rows) / 100;
      eAgg.returnedAmount += rSum;
      eAgg.returnedItems += rItems;
      if (voidedThisReturn) {
        eAgg.receipts -= 1;
        eAgg.returnedReceipts += 1;
      }
      byEmployee.set(key, eAgg);
    }
  }

  // Computed from receipts + voided (not the post-void byRegister totals),
  // so a voided receipt is never miscounted as "skipped — inactive register".
  const skipped =
    demands.length - ([...byRegister.values()].reduce((acc, r) => acc + r.receipts, 0) + voidedReceipts);

  for (const [id, agg] of byRegister) {
    const { error: registerError } = await supabaseAdmin
      .from("moysklad_registers")
      .upsert({ id, name: agg.name, store: REGISTER_STORE[id] }, { onConflict: "id", ignoreDuplicates: false });
    if (registerError) throw registerError;

    const { error: salesError } = await supabaseAdmin.from("moysklad_sales_daily").upsert(
      {
        register_id: id,
        sale_date: date,
        revenue: agg.revenue,
        receipts_count: agg.receipts,
        items_count: agg.items,
        cost: agg.cost,
        returned_amount: agg.returnedAmount,
        returned_receipts: agg.returnedReceipts,
        returned_items: agg.returnedItems,
      },
      { onConflict: "register_id,sale_date" }
    );
    if (salesError) throw salesError;
  }

  for (const [key, agg] of byEmployee) {
    const employeeId = key.slice(0, key.lastIndexOf("|"));
    const { error: employeeSalesError } = await supabaseAdmin.from("moysklad_employee_sales_daily").upsert(
      {
        employee_ms_id: employeeId,
        employee_name: agg.name,
        sale_date: date,
        store: agg.store,
        revenue: agg.revenue,
        receipts_count: agg.receipts,
        items_count: agg.items,
        cost: agg.cost,
        returned_amount: agg.returnedAmount,
        returned_receipts: agg.returnedReceipts,
        returned_items: agg.returnedItems,
      },
      { onConflict: "employee_ms_id,sale_date,store" }
    );
    if (employeeSalesError) throw employeeSalesError;
  }

  const products = await syncProductSales(date);

  return {
    date,
    registers: byRegister.size,
    employees: byEmployee.size,
    products,
    receipts: demands.length,
    returns: returns.length,
    returnedAmount,
    voidedReceipts,
    skipped,
  };
}

// Продажи по товарам за день (и их себестоимость) — отдельно от продаж по кассам и
// сотрудникам, чтобы историю по товарам можно было восстановить, не трогая остальные
// цифры (?productsOnly=1).
async function syncProductSales(date: string): Promise<number> {
  // One /report/profit/byproduct call per склад (МойСклад's store filter
  // only ever accepts a single value — see fetchProfitByProductForDate).
  // Sequential, not Promise.all: МойСклад rate-limits concurrent requests
  // (confirmed live — 6 parallel calls tripped a 429 "too many concurrent
  // requests"), so this trades a bit of wall-clock time for not failing.
  //
  // Saya Park's warehouse is skipped here from SAYA_PARK_RETIRED_FROM
  // onward (unlike in syncCatalogAndStock, where WAREHOUSE_STORE still
  // tracks its current stock unconditionally) — dates before that cutoff
  // are real historical sales and must still resync correctly.
  type ProductAgg = { name: string; revenue: number; quantity: number; cost: number; returnedAmount: number; returnedQuantity: number };
  const byProduct = new Map<string, ProductAgg>(); // key: `${productMsId}|${store}`
  const warehouseIds = Object.keys(WAREHOUSE_STORE).filter(
    (id) => !(id === SAYA_PARK_WAREHOUSE_ID && date >= SAYA_PARK_RETIRED_FROM)
  );
  const perWarehouse: Awaited<ReturnType<typeof fetchProfitByProductForDate>>[] = [];
  for (const whId of warehouseIds) {
    perWarehouse.push(await fetchProfitByProductForDate(date, whId));
  }
  let productRows = 0;
  for (let i = 0; i < warehouseIds.length; i++) {
    const store = WAREHOUSE_STORE[warehouseIds[i]];
    for (const p of perWarehouse[i]) {
      const key = `${p.productMsId}|${store}`;
      const agg = byProduct.get(key) ?? { name: p.name, revenue: 0, quantity: 0, cost: 0, returnedAmount: 0, returnedQuantity: 0 };
      agg.revenue += p.revenue;
      agg.quantity += p.quantity;
      agg.cost += p.cost;
      agg.returnedAmount += p.returnedAmount;
      agg.returnedQuantity += p.returnedQuantity;
      byProduct.set(key, agg);
    }
  }
  const productRowsToUpsert = [...byProduct.entries()].map(([key, agg]) => {
    const sep = key.lastIndexOf("|");
    return {
      product_ms_id: key.slice(0, sep),
      product_name: agg.name,
      article: deriveArticle(agg.name),
      sale_date: date,
      store: key.slice(sep + 1),
      revenue: agg.revenue,
      quantity: agg.quantity,
      cost: agg.cost,
      returned_amount: agg.returnedAmount,
      returned_quantity: agg.returnedQuantity,
    };
  });
  for (const batch of chunk(productRowsToUpsert, 500)) {
    const { error: productSalesError } = await supabaseAdmin
      .from("moysklad_product_sales_daily")
      .upsert(batch, { onConflict: "product_ms_id,sale_date,store" });
    if (productSalesError) throw productSalesError;
  }
  productRows = productRowsToUpsert.length;

  return productRows;
}

// Product catalog + current stock snapshot — not date-scoped (always
// "right now"), so this runs once per sync call regardless of which day's
// aggregates it's also pulling. moysklad_product_sales_daily.product_ms_id
// has an FK to moysklad_products, so the catalog upsert has to happen first.
function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function syncCatalogAndStock() {
  const products = await fetchAllProducts();
  const now = new Date().toISOString();

  // /report/stock/all gives one summed-across-everything number per product
  // plus its name/price/category/photo; /report/stock/bystore gives the
  // same product split by склад but without those — combine them, resolving
  // each склад to a city/frozen bucket via WAREHOUSE_STORE (anything
  // unmapped, e.g. "Кайнар", is dropped rather than guessed at). Fetched
  // before the catalog upsert below so that upsert can carry each
  // product's image_url along in the same pass.
  const [stockAll, stockByStore] = await Promise.all([fetchStockAll(), fetchStockByStore()]);
  const seenIds = new Set(products.map((p) => p.id));
  const infoById = new Map(stockAll.map((s) => [s.productMsId, s]));

  for (const batch of chunk(products, 500)) {
    const { error } = await supabaseAdmin.from("moysklad_products").upsert(
      batch.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        top_category: p.topCategory,
        buy_price: p.buyPrice,
        archived: p.archived,
        image_url: infoById.get(p.id)?.imageUrl ?? null,
        image_full_href: infoById.get(p.id)?.imageFullHref ?? null,
        article: deriveArticle(p.name),
        supplier: p.supplier,
        synced_at: now,
      })),
      { onConflict: "id" }
    );
    if (error) throw error;
  }

  const byStock = new Map<string, { productMsId: string; store: string; stock: number }>();
  for (const row of stockByStore) {
    const store = WAREHOUSE_STORE[row.warehouseId];
    if (!store || !seenIds.has(row.productMsId)) continue;
    const key = `${row.productMsId}|${store}`;
    const existing = byStock.get(key);
    if (existing) existing.stock += row.stock;
    else byStock.set(key, { productMsId: row.productMsId, store, stock: row.stock });
  }

  const stockRows = [...byStock.values()].flatMap(({ productMsId, store, stock }) => {
    const info = infoById.get(productMsId);
    if (!info || stock <= 0) return [];
    return [
      {
        product_ms_id: productMsId,
        product_name: info.name,
        category: info.category,
        top_category: info.topCategory,
        store,
        stock,
        buy_price: info.buyPrice,
        sale_price: info.salePrice,
        stock_days: info.stockDays,
        synced_at: now,
      },
    ];
  });
  for (const batch of chunk(stockRows, 500)) {
    const { error } = await supabaseAdmin.from("moysklad_product_stock").upsert(batch, { onConflict: "product_ms_id,store" });
    if (error) throw error;
  }

  // Таблица остатков хранит только позиции с остатком больше нуля. Всё, что распродано или
  // переехало, раньше оставалось в ней навсегда и раздувало себестоимость остатка (и занижало
  // оборачиваемость) — теперь такие строки удаляются. Защита: если пришло подозрительно
  // мало строк (сбой отчёта), ничего не удаляем.
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

  // Only ~400 приёмки ever — cheap enough to refetch and rebuild in full
  // every sync, same as the catalog/stock snapshot above.
  const supplies = await fetchAllSupplies();
  const bySupply = new Map<string, { productMsId: string; store: string; date: string }>();
  for (const row of supplies) {
    const store = WAREHOUSE_STORE[row.warehouseId];
    if (!store || !seenIds.has(row.productMsId)) continue;
    const key = `${row.productMsId}|${store}`;
    const existing = bySupply.get(key);
    if (!existing || row.date > existing.date) bySupply.set(key, { productMsId: row.productMsId, store, date: row.date });
  }
  const supplyRows = [...bySupply.values()].map(({ productMsId, store, date }) => ({
    product_ms_id: productMsId,
    store,
    last_supply_date: date,
    synced_at: now,
  }));
  for (const batch of chunk(supplyRows, 500)) {
    const { error } = await supabaseAdmin
      .from("moysklad_product_last_supply")
      .upsert(batch, { onConflict: "product_ms_id,store" });
    if (error) throw error;
  }

  // Каждая строка каждой приёмки — для раздела «По поставщикам → Приёмки» (сколько из какого прихода продано)
  const itemRows = supplies.flatMap((row) => {
    const store = WAREHOUSE_STORE[row.warehouseId];
    if (!store || !seenIds.has(row.productMsId) || !row.supplyId) return [];
    return [
      {
        supply_id: row.supplyId,
        line_no: row.line,
        doc_name: row.docName,
        doc_date: row.date,
        store,
        product_ms_id: row.productMsId,
        quantity: row.quantity,
        price: row.price,
        agent_name: row.agentName,
        synced_at: now,
      },
    ];
  });
  for (const batch of chunk(itemRows, 500)) {
    const { error } = await supabaseAdmin.from("moysklad_supply_items").upsert(batch, { onConflict: "supply_id,line_no" });
    if (error) throw error;
  }
  // удалённые или изменённые в МойСклад приёмки: всё, что не обновилось в этой синхронизации, убираем
  if (itemRows.length > 0) {
    const { error } = await supabaseAdmin.from("moysklad_supply_items").delete().lt("synced_at", now);
    if (error) throw error;
  }

  return { products: products.length, stockRows: stockRows.length, staleRemoved, supplyRows: supplyRows.length, supplyItems: itemRows.length };
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? yesterdayInAlmaty();
  // Catalog + stock are a full-account snapshot (not date-scoped), so a
  // multi-date backfill only needs to pay for it once — every other call in
  // the loop passes this to skip straight to that date's aggregates.
  const skipCatalog = url.searchParams.get("skipCatalog") === "1";

  // ?productsOnly=1 — только продажи по товарам за день (для восстановления истории
  // себестоимости; продажи по кассам и сотрудникам не пересчитываются).
  const productsOnly = url.searchParams.get("productsOnly") === "1";
  // ?snapshot=YYYY-MM-DD (или yesterday) — только снимок остатков на конец этого дня для
  // оборачиваемости по среднему остатку. Отдельным заданием pg_cron каждую ночь (не внутри
  // основной синхронизации — она и так долгая) и для восстановления истории.
  const snapshotParam = url.searchParams.get("snapshot");
  const snapshotDate = snapshotParam === "yesterday" ? yesterdayInAlmaty() : snapshotParam;

  try {
    if (snapshotDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });
      try {
        return NextResponse.json({ ok: true, snapshot: snapshotDate, rows: await snapshotStockForDate(snapshotDate) });
      } catch (e) {
        const message = getErrorMessage(e);
        await supabaseAdmin
          .from("notifications")
          .insert({ type: "sync_error", message: `Снимок остатков не сохранился (${snapshotDate}): ${message}` });
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }
    if (productsOnly) {
      return NextResponse.json({ ok: true, date, products: await syncProductSales(date) });
    }
    const catalog = skipCatalog ? null : await syncCatalogAndStock();
    const result = await runSync(date);
    await supabaseAdmin
      .from("moysklad_sync_state")
      .update({ last_synced_at: new Date().toISOString(), last_status: "ok", last_error: null })
      .eq("id", true);
    return NextResponse.json({ ok: true, ...result, catalog });
  } catch (e) {
    // Supabase/PostgREST errors are plain {message, code, ...} objects, not
    // Error instances — `e instanceof Error ? e.message : String(e)` missed
    // those and silently recorded "[object Object]", which is exactly what
    // hid the real cause of the nightly sync failure on 2026-09-29.
    const message = getErrorMessage(e);
    await supabaseAdmin
      .from("moysklad_sync_state")
      .update({ last_synced_at: new Date().toISOString(), last_status: "error", last_error: message })
      .eq("id", true);
    // Surfaces in the notification bell — moysklad_sync_state alone was
    // easy to miss, which is exactly how the nightly sync silently failed
    // once before nobody thought to check it.
    await supabaseAdmin
      .from("notifications")
      .insert({ type: "sync_error", message: `Синхронизация МойСклад не удалась (${date}): ${message}` });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
