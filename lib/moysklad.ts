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
