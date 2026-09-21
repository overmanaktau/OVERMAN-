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
      expand: "retailStore,positions",
    });
    const rows: T[] = page.rows ?? [];
    all.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

export type RetailDemand = {
  moment: string; // "2026-09-21 14:32:00.000"
  sum: number; // total in kopecks
  // "retailStore" (точка продаж / касса) is what the business actually uses
  // to tell registers apart — "store" (склад) is just the warehouse stock
  // gets deducted from, and doesn't carry the city in its name.
  retailStore?: { name?: string; id?: string } | null;
  positions?: { rows?: { quantity?: number }[]; meta?: { size?: number } };
};

// Pulls all retail sale documents (retaildemand) for the given date (local
// calendar day). Money in МойСклад is in kopecks — callers divide by 100.
export async function fetchRetailDemandsForDate(date: string): Promise<RetailDemand[]> {
  const filter = `moment>=${date} 00:00:00;moment<=${date} 23:59:59`;
  return fetchAllPages<RetailDemand>("/entity/retaildemand", filter);
}
