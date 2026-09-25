// Server-only client for the МойСклад JSON API. Never import this from
// client components — MOYSKLAD_API_TOKEN must stay server-side.
const BASE_URL = "https://api.moysklad.ru/api/remap/1.2";

function getToken(): string {
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (!token) throw new Error("MOYSKLAD_API_TOKEN не задан.");
  return token;
}

async function moyskladFetch(path: string, searchParams?: Record<string, string>) {
  const url = new URL(`${BASE_URL}${path}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json;charset=utf-8",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`МойСклад API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function fetchAllPages<T>(path: string, filter: string): Promise<T[]> {
  const limit = 100;
  let offset = 0;
  const all: T[] = [];
  for (;;) {
    const page = await moyskladFetch(path, {
      filter,
      limit: String(limit),
      offset: String(offset),
      // Deep-expand so each position's assortment (and, for a variant —
      // colour/size modification — its parent product) is fully embedded,
      // not just a meta reference. Cost (buyPrice) lives on the product,
      // never on the position itself, and a variant doesn't carry its own
      // buyPrice — only the product it belongs to does.
      expand: "retailStore,owner,positions.assortment,positions.assortment.product",
    });
    const rows: T[] = page.rows ?? [];
    all.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

type Money = { value: number } | null | undefined;
export type PositionRow = {
  quantity?: number;
  assortment?: {
    meta?: { type?: string };
    buyPrice?: Money;
    product?: { buyPrice?: Money };
  };
};

// Себестоимость (buyPrice, закупочная цена) — per unit, in kopecks. Lives on
// the product itself when the position's assortment IS a plain product, or
// on assortment.product when it's a variant (a colour/size modification).
export function totalCostKopecks(rows: PositionRow[] | undefined): number {
  return (rows ?? []).reduce((acc, p) => {
    const unitCost = p.assortment?.buyPrice?.value ?? p.assortment?.product?.buyPrice?.value ?? 0;
    return acc + unitCost * (p.quantity ?? 0);
  }, 0);
}

export type RetailDemand = {
  meta?: { href?: string };
  moment: string; // "2026-09-21 14:32:00.000"
  sum: number; // total in kopecks
  // "retailStore" (точка продаж / касса) is what the business actually uses
  // to tell registers apart — "store" (склад) is just the warehouse stock
  // gets deducted from, and doesn't carry the city in its name.
  retailStore?: { name?: string; id?: string } | null;
  // The employee who actually rang up the sale (МойСклад's "ответственный") —
  // confirmed live to vary by real cashier, not a generic API/admin user.
  owner?: { name?: string; id?: string } | null;
  positions?: { rows?: PositionRow[]; meta?: { size?: number } };
};

// The business's "day" for a given date runs from that date's midnight
// through 02:00 the following morning (matches the nightly sync itself
// running at 02:00 Aktau) — not a strict calendar-day cutoff at 23:59.
function dayWindow(date: string): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDate = next.toISOString().slice(0, 10);
  return { from: `${date} 00:00:00`, to: `${nextDate} 02:00:00` };
}

// Pulls all retail sale documents (retaildemand) for the given date's
// business day (see dayWindow above). Money in МойСклад is in kopecks —
// callers divide by 100.
export async function fetchRetailDemandsForDate(date: string): Promise<RetailDemand[]> {
  const { from, to } = dayWindow(date);
  const filter = `moment>=${from};moment<${to}`;
  return fetchAllPages<RetailDemand>("/entity/retaildemand", filter);
}

// A return (retailsalesreturn) always references the original sale via
// "demand". It always adjusts revenue/items on the day the RETURN itself
// happened (not the original sale's day) — a return processed today reduces
// today's numbers, full stop. It additionally voids the receipt itself
// (receipts_count -1) when the original check had exactly one item, since
// returning it means that check no longer represents a completed sale; a
// return from a multi-item check leaves the receipt counted, just smaller.
export type RetailSalesReturn = {
  sum: number; // kopecks
  retailStore?: { name?: string; id?: string } | null;
  owner?: { name?: string; id?: string } | null;
  positions?: { rows?: PositionRow[] };
  demand?: { meta?: { href?: string } } | null;
};

export async function fetchRetailSalesReturnsForDate(date: string): Promise<RetailSalesReturn[]> {
  const { from, to } = dayWindow(date);
  const filter = `moment>=${from};moment<${to}`;
  return fetchAllPages<RetailSalesReturn>("/entity/retailsalesreturn", filter);
}

// A return doesn't carry its original check's total item count — only what
// was returned. Need one extra lookup per return (there are only ever a
// handful per day) to tell "the whole check was a single item" from "this
// was one item out of several".
export async function fetchDemandItemCount(demandHref: string): Promise<number> {
  const url = new URL(demandHref);
  url.searchParams.set("expand", "positions");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/json;charset=utf-8" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`МойСклад API ${res.status}: ${body.slice(0, 500)}`);
  }
  const demand = await res.json();
  const rows: { quantity?: number }[] = demand.positions?.rows ?? [];
  return rows.reduce((acc, p) => acc + (p.quantity ?? 0), 0);
}

// Full product catalog (name + category/productFolder + cost) — used to
// label and categorize the daily per-product sales and the stock snapshot
// below. ~5-6k rows; paginated at 100/page like everything else here.
export type ProductCatalogRow = {
  id: string;
  name: string;
  category: string | null;
  buyPrice: number | null; // tenge (already /100 from kopecks)
  archived: boolean;
};

// МойСклад's default /entity/product listing silently excludes archived
// products (confirmed live: no filter and filter=archived=false return the
// same count) — an archived item can still have real leftover stock sitting
// on a shelf, which is exactly what "Зависшие остатки" needs to catch, so
// this fetches both and merges them rather than trusting the default.
async function fetchProductPage(archived: boolean): Promise<ProductCatalogRow[]> {
  const limit = 100;
  let offset = 0;
  const all: ProductCatalogRow[] = [];
  for (;;) {
    const page = await moyskladFetch("/entity/product", {
      expand: "productFolder",
      filter: `archived=${archived}`,
      limit: String(limit),
      offset: String(offset),
    });
    type Raw = {
      id: string;
      name: string;
      archived?: boolean;
      productFolder?: { name?: string };
      buyPrice?: Money;
    };
    const rows: Raw[] = page.rows ?? [];
    for (const p of rows) {
      all.push({
        id: p.id,
        name: p.name,
        category: p.productFolder?.name ?? null,
        buyPrice: p.buyPrice?.value != null ? p.buyPrice.value / 100 : null,
        archived: p.archived ?? false,
      });
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

export async function fetchAllProducts(): Promise<ProductCatalogRow[]> {
  const [active, archived] = await Promise.all([fetchProductPage(false), fetchProductPage(true)]);
  return [...active, ...archived];
}

// Current stock snapshot — МойСклад's own /report/stock/all, which already
// includes "stockDays" (оборачиваемость: how many days this item's current
// stock has been sitting without moving), so "Зависшие остатки" doesn't need
// any historical tracking of our own — it's a live read of this report.
export type StockReportRow = {
  productMsId: string;
  name: string;
  category: string | null;
  stock: number;
  buyPrice: number | null; // tenge — "price" field in the report is cost, not sale price
  stockDays: number | null;
};

export async function fetchStockAll(): Promise<StockReportRow[]> {
  const limit = 100;
  let offset = 0;
  const all: StockReportRow[] = [];
  for (;;) {
    const page = await moyskladFetch("/report/stock/all", {
      limit: String(limit),
      offset: String(offset),
    });
    type Raw = {
      meta?: { href?: string };
      name: string;
      stock?: number;
      price?: number; // kopecks, cost basis
      stockDays?: number;
      folder?: { name?: string };
    };
    const rows: Raw[] = page.rows ?? [];
    for (const r of rows) {
      const href = r.meta?.href ?? "";
      const id = href.split("/").pop()?.split("?")[0] ?? "";
      if (!id) continue;
      all.push({
        productMsId: id,
        name: r.name,
        category: r.folder?.name ?? null,
        stock: r.stock ?? 0,
        buyPrice: r.price != null ? r.price / 100 : null,
        stockDays: r.stockDays ?? null,
      });
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

// Per-product revenue/cost/quantity for one business day, straight from
// МойСклад's own profit report — it already nets sales against returns and
// computes cost server-side (no need to walk positions.rows ourselves, the
// way the register/employee aggregation above does).
export type ProductDayAgg = {
  productMsId: string;
  name: string;
  revenue: number; // tenge, net of returns
  quantity: number; // net of returns
  cost: number; // tenge
  returnedAmount: number;
  returnedQuantity: number;
};

export async function fetchProfitByProductForDate(date: string): Promise<ProductDayAgg[]> {
  const { from, to } = dayWindow(date);
  const limit = 100;
  let offset = 0;
  const all: ProductDayAgg[] = [];
  for (;;) {
    const page = await moyskladFetch("/report/profit/byproduct", {
      momentFrom: from,
      momentTo: to,
      limit: String(limit),
      offset: String(offset),
    });
    type Raw = {
      assortment?: { meta?: { href?: string }; name?: string };
      sellSum?: number;
      sellQuantity?: number;
      sellCostSum?: number;
      returnSum?: number;
      returnQuantity?: number;
      returnCostSum?: number;
    };
    const rows: Raw[] = page.rows ?? [];
    for (const r of rows) {
      const href = r.assortment?.meta?.href ?? "";
      const id = href.split("/").pop()?.split("?")[0] ?? "";
      if (!id || !r.assortment?.name) continue;
      all.push({
        productMsId: id,
        name: r.assortment.name,
        revenue: ((r.sellSum ?? 0) - (r.returnSum ?? 0)) / 100,
        quantity: (r.sellQuantity ?? 0) - (r.returnQuantity ?? 0),
        cost: ((r.sellCostSum ?? 0) - (r.returnCostSum ?? 0)) / 100,
        returnedAmount: (r.returnSum ?? 0) / 100,
        returnedQuantity: r.returnQuantity ?? 0,
      });
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}
