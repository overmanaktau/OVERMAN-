import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireKassa } from "@/lib/kassa/access";
import * as cert from "@/lib/kassa/certificates";

export const maxDuration = 60;

// Сертификаты на кассе. GET: ?store=&number= поиск, ?store=&sellers=1 продавцы, ?store=&checks=1 чеки дня.
// POST: {store, action: verify|use|request|return|sell, …}. Город — только из доступов входа.
function pickStore(caller: { stores: string[] }, requested: string | null): string | null {
  const store = requested && caller.stores.includes(requested) ? requested : caller.stores.length === 1 ? caller.stores[0] : null;
  return store;
}

export async function GET(request: Request) {
  const caller = await requireKassa(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const url = new URL(request.url);
  const store = pickStore(caller, url.searchParams.get("store"));
  if (!store) return NextResponse.json({ error: "Выберите город." }, { status: 400 });
  try {
    if (url.searchParams.get("sellers") === "1") return NextResponse.json({ sellers: await cert.sellers(store) });
    if (url.searchParams.get("checks") === "1") return NextResponse.json({ checks: await cert.todayChecks(store) });
    const number = (url.searchParams.get("number") ?? "").trim();
    if (!number) return NextResponse.json({ error: "Введите номер сертификата." }, { status: 400 });
    return NextResponse.json(await cert.lookup(store, number));
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const caller = await requireKassa(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const store = pickStore(caller, typeof body.store === "string" ? body.store : null);
    if (!store) return NextResponse.json({ error: "Выберите город." }, { status: 400 });
    const certId = Number(body.certId);
    const demandId = String(body.demandId ?? "");
    let result: unknown;
    switch (body.action) {
      case "verify":
        result = await cert.verify(store, certId, demandId);
        break;
      case "use":
        result = await cert.use(store, certId, demandId, caller.name);
        break;
      case "request":
        result = await cert.requestOwner(store, certId, demandId, caller.name);
        break;
      case "return":
        result = await cert.giveBack(store, certId, caller.name);
        break;
      case "sell":
        result = await cert.sell(store, body as unknown as cert.SellInput, caller.name);
        break;
      default:
        return NextResponse.json({ error: "Неизвестное действие." }, { status: 400 });
    }
    const failed = typeof result === "object" && result !== null && "error" in result;
    return NextResponse.json(result, { status: failed ? 400 : 200 });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
