import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireSectionStores } from "@/lib/sectionAccess";
import { citySellers, type CitySellers } from "@/lib/sellers/overview";

export const maxDuration = 60;

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const CACHE_MS = 2 * 60 * 1000; // расчёт ходит в МойСклад за сегодняшний день — не чаще раза в 2 минуты на город
const cache = new Map<string, { at: number; data: CitySellers }>();

// Продавцы города за текущий месяц для руководителей. GET ?store=point_1 — город (по умолчанию первый из доступных); в ответе stores — доступные города.
export async function GET(request: Request) {
  const caller = await requireSectionStores(request, "sellers.list", "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const stores = caller.stores.filter((c) => CITY[c]).sort();
  if (stores.length === 0) return NextResponse.json({ error: "Нет доступных городов." }, { status: 403 });
  const requested = new URL(request.url).searchParams.get("store");
  const store = requested && stores.includes(requested) ? requested : stores[0];
  try {
    const hit = cache.get(store);
    let data: CitySellers;
    if (hit && Date.now() - hit.at < CACHE_MS) {
      data = hit.data;
    } else {
      data = await citySellers(store);
      cache.set(store, { at: Date.now(), data });
    }
    return NextResponse.json({ stores: stores.map((code) => ({ code, label: CITY[code] })), store, data });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
