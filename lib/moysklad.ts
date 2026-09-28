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
  // МойСклад silently stops honoring "expand" once limit > 100 — confirmed
  // live: at limit=1000 every expanded reference here (retailStore, owner,
  // positions.assortment) degrades to a bare {meta} stub, which is why this
  // stays at 100 while the non-expand report endpoints below use 1000.
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

// Only ~40 folders total — one cheap page, used to resolve each product's
// category without needing expand=productFolder (which forced limit=100 on
// the ~5,800-row product fetch below; productFolder is a bare {meta} ref
// even without expand, so this trades one small extra request for letting
// that fetch run at the full page size instead).
async function fetchProductFolderNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const page = await moyskladFetch("/entity/productfolder", { limit: "1000", offset: String(offset) });
    type Raw = { id: string; name: string };
    const rows: Raw[] = page.rows ?? [];
    for (const f of rows) map.set(f.id, f.name);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return map;
}

// МойСклад's default /entity/product listing silently excludes archived
// products (confirmed live: no filter and filter=archived=false return the
// same count) — an archived item can still have real leftover stock sitting
// on a shelf, which is exactly what "Зависшие остатки" needs to catch, so
// this fetches both and merges them rather than trusting the default.
async function fetchProductPage(archived: boolean, folderNames: Map<string, string>): Promise<ProductCatalogRow[]> {
  const limit = 1000; // safe at max page size — no expand needed (see fetchProductFolderNames)
  let offset = 0;
  const all: ProductCatalogRow[] = [];
  for (;;) {
    const page = await moyskladFetch("/entity/product", {
      filter: `archived=${archived}`,
      limit: String(limit),
      offset: String(offset),
    });
    type Raw = {
      id: string;
      name: string;
      archived?: boolean;
      productFolder?: { meta?: { href?: string } };
      buyPrice?: Money;
    };
    const rows: Raw[] = page.rows ?? [];
    for (const p of rows) {
      const folderHref = p.productFolder?.meta?.href ?? "";
      const folderId = folderHref.split("/").pop()?.split("?")[0] ?? "";
      all.push({
        id: p.id,
        name: p.name,
        category: folderId ? folderNames.get(folderId) ?? null : null,
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
  const folderNames = await fetchProductFolderNames();
  const [active, archived] = await Promise.all([fetchProductPage(false, folderNames), fetchProductPage(true, folderNames)]);
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
  salePrice: number | null; // tenge — "salePrice" field, the retail price
  stockDays: number | null;
  imageUrl: string | null; // confirmed live: loads with no Authorization header — safe as a plain <img src>
};

export async function fetchStockAll(): Promise<StockReportRow[]> {
  const limit = 1000; // safe at max page size — this report doesn't use expand, unlike the entity endpoints above
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
      salePrice?: number; // kopecks, retail price
      stockDays?: number;
      folder?: { name?: string };
      image?: { tiny?: { href?: string }; miniature?: { downloadHref?: string } };
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
        salePrice: r.salePrice != null ? r.salePrice / 100 : null,
        stockDays: r.stockDays ?? null,
        imageUrl: r.image?.miniature?.downloadHref ?? r.image?.tiny?.href ?? null,
      });
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

// Per-warehouse stock breakdown — /report/stock/all gives one number per
// product (summed across every склад); this instead gives each склад's own
// quantity, which is what lets "Зависшие остатки" and АВС/XYZ be filtered
// by city. Name/price/category aren't in this report's rows at all (only
// each nested store's own name) — callers cross-reference fetchStockAll()
// for those, keyed by product id.
export type StoreStockRow = {
  productMsId: string;
  warehouseId: string;
  stock: number;
};

export async function fetchStockByStore(): Promise<StoreStockRow[]> {
  const limit = 1000; // safe at max page size — no expand param here either
  let offset = 0;
  const all: StoreStockRow[] = [];
  for (;;) {
    const page = await moyskladFetch("/report/stock/bystore", {
      limit: String(limit),
      offset: String(offset),
    });
    type Raw = {
      meta?: { href?: string };
      stockByStore?: { meta?: { href?: string }; stock?: number }[];
    };
    const rows: Raw[] = page.rows ?? [];
    for (const r of rows) {
      const href = r.meta?.href ?? "";
      const productId = href.split("/").pop()?.split("?")[0] ?? "";
      if (!productId) continue;
      for (const w of r.stockByStore ?? []) {
        const whHref = w.meta?.href ?? "";
        const warehouseId = whHref.split("/").pop()?.split("?")[0] ?? "";
        if (!warehouseId || !w.stock) continue; // 0/undefined stock at that склад — nothing to track
        all.push({ productMsId: productId, warehouseId, stock: w.stock });
      }
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

// Per-product revenue/cost/quantity for one business day, straight from
// МойСклад's own profit report — it already nets sales against returns and
// computes cost server-side (no need to walk positions.rows ourselves, the
// way the register/employee aggregation above does). МойСклад's "store"
// filter only accepts one value per call (confirmed live — a second store=
// errors, and comma-joining silently keeps only the last one), so a
// per-warehouse breakdown means one call per склад, not one call total.
export type ProductDayAgg = {
  productMsId: string;
  name: string;
  revenue: number; // tenge, net of returns
  quantity: number; // net of returns
  cost: number; // tenge
  returnedAmount: number;
  returnedQuantity: number;
};

export async function fetchProfitByProductForDate(date: string, warehouseId?: string): Promise<ProductDayAgg[]> {
  const { from, to } = dayWindow(date);
  const limit = 1000; // safe at max page size — no expand param here either
  let offset = 0;
  const all: ProductDayAgg[] = [];
  for (;;) {
    const page = await moyskladFetch("/report/profit/byproduct", {
      momentFrom: from,
      momentTo: to,
      limit: String(limit),
      offset: String(offset),
      ...(warehouseId ? { filter: `store=${BASE_URL}/entity/store/${warehouseId}` } : {}),
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

// Приёмки (goods-received documents) — only ~400 of these ever, so unlike
// everything else here this is a single full fetch, not a per-day sync.
// Lets "Зависшие остатки" tell "just arrived, hasn't had a chance to sell
// yet" apart from "been sitting dead for months" — a product restocked
// recently shouldn't count as stale just because it hasn't sold yet.
export type SupplyRow = {
  productMsId: string;
  warehouseId: string;
  date: string; // YYYY-MM-DD
};

export async function fetchAllSupplies(): Promise<SupplyRow[]> {
  // expand=positions (bare, no ".assortment") still embeds each position's
  // assortment as a normal {meta} reference — plenty to read the product id
  // from — while the deeper ".assortment" expansion confirmed ~2.6x slower
  // live (27s/page vs 10s/page) for data this function never uses beyond
  // that href. And expand silently stops working past limit=100 at all
  // (confirmed live, same as fetchAllPages above), so this stays there.
  const limit = 100;
  let offset = 0;
  const all: SupplyRow[] = [];
  for (;;) {
    const page = await moyskladFetch("/entity/supply", {
      expand: "positions",
      limit: String(limit),
      offset: String(offset),
    });
    type Raw = {
      moment?: string;
      store?: { meta?: { href?: string } };
      positions?: { rows?: { assortment?: { meta?: { href?: string } } }[] };
    };
    const rows: Raw[] = page.rows ?? [];
    for (const r of rows) {
      const storeHref = r.store?.meta?.href ?? "";
      const warehouseId = storeHref.split("/").pop()?.split("?")[0] ?? "";
      const date = (r.moment ?? "").slice(0, 10);
      if (!warehouseId || !date) continue;
      for (const p of r.positions?.rows ?? []) {
        const href = p.assortment?.meta?.href ?? "";
        const productId = href.split("/").pop()?.split("?")[0] ?? "";
        if (!productId) continue;
        all.push({ productMsId: productId, warehouseId, date });
      }
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

// This account has no working "артикул" field — every colour/size gets its
// own top-level product with an empty article field and a sequential,
// unrelated code (confirmed live: 8 colour/size siblings of one style had 8
// consecutive-but-unrelated `code` values, e.g. "04394".."04401"). The only
// place the shared style number lives is the free-text name, e.g.
// "Кардиган  B8271 Black exodor (3XL)" — so this peels trailing
// size/supplier-line qualifiers off the name, one token at a time, split on
// whichever of "/", "," or a space sits closest to the end. It only strips
// a token when it's a recognized word (never blindly cuts on the separator
// alone), so an unrecognized qualifier — a typo, a supplier tag not in the
// list, a Cyrillic homoglyph — just leaves that one SKU ungrouped instead
// of merging it into the wrong bucket or eating the article code.
//
// Colour words are deliberately NOT in this list: per the business, a
// colour is a different model (a different "артикул"), only sizes of the
// same colour share one — so colour stays in the derived string and two
// SKUs that differ only by colour end up as two different articles.
const ARTICLE_STRIP_WORDS = [
  "calidad", "masculino", "bottino", "ексодор", "exodor", "codeno", "liwali", "cadeno", "daz", "polo", "sergio",
  "калидад", "маскулино", "боттино", "индастри",
  "батал", "бебатл",
];
const ARTICLE_STRIP_SET = new Set(ARTICLE_STRIP_WORDS.map((w) => w.toLowerCase()));

export function deriveArticle(name: string): string {
  let s = name.replace(/\s*\([^)]*\)/g, " ").trim();
  for (;;) {
    const m = s.match(/^(.*)[/,\s]([^/,\s]+)$/);
    if (!m) break;
    const [, rest, lastToken] = m;
    if (!ARTICLE_STRIP_SET.has(lastToken.toLowerCase())) break;
    const trimmedRest = rest.trim();
    if (!trimmedRest) break; // never strip the whole name down to nothing
    s = trimmedRest;
  }
  s = s.replace(/[/,\s]+$/, "").trim();
  return s || name.trim();
}
