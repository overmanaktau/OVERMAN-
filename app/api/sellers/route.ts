import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { isValidSession } from "@/lib/sellers/session";
import { citySellers, type CitySellers } from "@/lib/sellers/overview";

export const maxDuration = 60;

const CITIES = [
  { code: "point_1", label: "Актау" },
  { code: "point_3", label: "Актобе" },
];
const CACHE_MS = 2 * 60 * 1000; // расчёт ходит в МойСклад за сегодняшний день — не чаще раза в 2 минуты на город
const cache = new Map<string, { at: number; data: CitySellers }>();

// Продавцы города за текущий месяц для руководителей (страница /seller). Нужен пропуск после входа по логину и паролю (заголовок Authorization).
// GET ?store=point_1 — город (по умолчанию Актау); в ответе stores — оба города.
export async function GET(request: Request) {
  if (!isValidSession(request.headers.get("authorization"))) return NextResponse.json({ error: "Нужен вход." }, { status: 401 });
  const requested = new URL(request.url).searchParams.get("store");
  const store = CITIES.find((c) => c.code === requested)?.code ?? CITIES[0].code;
  try {
    const hit = cache.get(store);
    let data: CitySellers;
    if (hit && Date.now() - hit.at < CACHE_MS) {
      data = hit.data;
    } else {
      data = await citySellers(store);
      cache.set(store, { at: Date.now(), data });
    }
    return NextResponse.json({ stores: CITIES, store, data });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
