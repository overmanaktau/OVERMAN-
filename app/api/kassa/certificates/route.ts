import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireKassa } from "@/lib/kassa/access";
import * as cert from "@/lib/kassa/certificates";
import { nextCertificateNumber } from "@/lib/kassa/certNumber";

export const maxDuration = 60;

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
// В журнале сертификатов общий вход кассы пишется как «Касса Актау» / «Касса Актобе»; админ/владелец — своим именем.
const actorOf = (caller: { name: string; admin: boolean }, store: string) => (caller.admin ? `${caller.name} (касса ${CITY[store] ?? store})` : `Касса ${CITY[store] ?? store}`);

// Сертификаты на кассе. GET: ?store=&number= поиск, ?store=&sellers=1 продавцы, ?store=&checks=1 чеки дня.
// ?store=&next=1 очередной номер сертификата (подсказка при продаже).
// ?store=&status=1&certId= статус запроса руководителю, ?store=&pending=1 запросы, ждущие ответа.
// POST: {store, action: verify|use|request|cancelRequest|return|sell, …}. Город — только из доступов входа.
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
    if (url.searchParams.get("next") === "1") return NextResponse.json({ next: await nextCertificateNumber(store) });
    if (url.searchParams.get("sellers") === "1") return NextResponse.json({ sellers: await cert.sellers(store) });
    if (url.searchParams.get("checks") === "1") return NextResponse.json({ checks: await cert.todayChecks(store) });
    if (url.searchParams.get("pending") === "1") return NextResponse.json({ pending: await cert.pendingRequests(store) });
    if (url.searchParams.get("status") === "1") return NextResponse.json(await cert.requestStatus(store, Number(url.searchParams.get("certId"))));
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
        result = await cert.use(store, certId, demandId, actorOf(caller, store));
        break;
      case "request":
        result = await cert.requestOwner(store, certId, demandId, actorOf(caller, store));
        break;
      case "cancelRequest":
        result = await cert.cancelRequest(store, certId, actorOf(caller, store));
        break;
      case "return":
        result = await cert.giveBack(store, certId, actorOf(caller, store));
        break;
      case "sell":
        result = await cert.sell(store, body as unknown as cert.SellInput, actorOf(caller, store));
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
