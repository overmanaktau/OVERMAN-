import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import {
  fetchRetailDemandsForDate,
  fetchRetailSalesReturnsForDate,
  fetchDemandItemCount,
  totalCostKopecks,
  fetchAllProducts,
  fetchStockAll,
  fetchStockByStore,
  fetchAllSupplies,
  fetchProfitByProductForDate,
  deriveArticle,
} from "@/lib/moysklad";

// Confirmed with the business owner: these are the only live registers
// (МойСклад entity/retailstore, "точки продаж" — not "склад", which
// doesn't carry the city in its name). "Онлайн продажи Overman" and
// "Ак Кала" are inactive retailstore entries and get skipped.
const REGISTER_STORE: Record<string, string> = {
  "01e67f9f-b012-11f0-0a80-0d700024a20d": "point_1", // Overman Актау
  "d3f209de-4da2-11f0-0a80-027a0003cde2": "point_1", // Saya Park
  "26e2dddd-a37f-11f1-0a80-1a76002585af": "point_3", // Overman Актобе
  "111827a0-a440-11f1-0a80-0dcb003111ce": "point_3", // Актобе скидка
};

// Warehouses (entity/store — where stock physically sits, distinct from the
// retailstore/касса ids above) mapped to the same city codes. Confirmed with
// the business owner: "Кайнар" is empty and not worth tracking, so it (and
// anything else not listed here) is simply skipped by the sync. The two
// "заморозка"/frozen warehouses hold written-off-for-now stock the business
// tracks on purpose as its own bucket, held back until next season — never
// folded into a city's live total.
const WAREHOUSE_STORE: Record<string, string> = {
  "109ed308-b012-11f0-0a80-110900247319": "point_1", // Overman
  "fe3b03d3-4da1-11f0-0a80-18910004c37d": "point_1", // Saya Park
  "bb935bd2-93e9-11f1-0a80-1f560022775d": "point_3", // Aktobe OVERMAN
  "2ca9443b-a440-11f1-0a80-03ac00324d3c": "point_3", // Актобе скидка
  "14352a86-5e96-11f1-0a80-1cbd00149396": "frozen", // заморозка 03.06.2026
  "554d7479-2728-11f0-0a80-15980025a3f6": "frozen", // Заморозка 24.02.2026
};

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
  // also voids the receipt itself (receipts_count -1) when the original
  // check was a single item, since there's no completed sale left; a return
  // from a multi-item check just shrinks that receipt, it doesn't void it.
  // returnedAmount/returnedReceipts/returnedItems are kept alongside so the
  // UI can show both the final (already-netted) figure and, next to it, how
  // much of it was returns.
  let returnedAmount = 0;
  let voidedReceipts = 0;
  for (const r of returns) {
    const id = r.retailStore?.id;
    const name = r.retailStore?.name;
    if (!id || !name || !REGISTER_STORE[id]) continue;
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
      const originalItemCount = await fetchDemandItemCount(demandHref);
      if (originalItemCount === 1) {
        agg.receipts = Math.max(0, agg.receipts - 1);
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
        eAgg.receipts = Math.max(0, eAgg.receipts - 1);
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

  // One /report/profit/byproduct call per склад (МойСклад's store filter
  // only ever accepts a single value — see fetchProfitByProductForDate),
  // then summed into this day's city/frozen buckets — several склады can
  // resolve to the same bucket (e.g. Overman + Saya Park → point_1).
  // Sequential, not Promise.all: МойСклад rate-limits concurrent requests
  // (confirmed live — 6 parallel calls tripped a 429 "too many concurrent
  // requests"), so this trades a bit of wall-clock time for not failing.
  type ProductAgg = { name: string; revenue: number; quantity: number; cost: number; returnedAmount: number; returnedQuantity: number };
  const byProduct = new Map<string, ProductAgg>(); // key: `${productMsId}|${store}`
  const warehouseIds = Object.keys(WAREHOUSE_STORE);
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

  return {
    date,
    registers: byRegister.size,
    employees: byEmployee.size,
    products: productRows,
    receipts: demands.length,
    returns: returns.length,
    returnedAmount,
    voidedReceipts,
    skipped,
  };
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
  for (const batch of chunk(products, 500)) {
    const { error } = await supabaseAdmin.from("moysklad_products").upsert(
      batch.map((p) => ({ id: p.id, name: p.name, category: p.category, buy_price: p.buyPrice, archived: p.archived, synced_at: now })),
      { onConflict: "id" }
    );
    if (error) throw error;
  }

  // /report/stock/all gives one summed-across-everything number per product
  // plus its name/price/category; /report/stock/bystore gives the same
  // product split by склад but without name/price/category — combine them,
  // resolving each склад to a city/frozen bucket via WAREHOUSE_STORE
  // (anything unmapped, e.g. "Кайнар", is dropped rather than guessed at).
  const [stockAll, stockByStore] = await Promise.all([fetchStockAll(), fetchStockByStore()]);
  const seenIds = new Set(products.map((p) => p.id));
  const infoById = new Map(stockAll.map((s) => [s.productMsId, s]));

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

  return { products: products.length, stockRows: stockRows.length, supplyRows: supplyRows.length };
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

  try {
    const catalog = skipCatalog ? null : await syncCatalogAndStock();
    const result = await runSync(date);
    await supabaseAdmin
      .from("moysklad_sync_state")
      .update({ last_synced_at: new Date().toISOString(), last_status: "ok", last_error: null })
      .eq("id", true);
    return NextResponse.json({ ok: true, ...result, catalog });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabaseAdmin
      .from("moysklad_sync_state")
      .update({ last_synced_at: new Date().toISOString(), last_status: "error", last_error: message })
      .eq("id", true);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
