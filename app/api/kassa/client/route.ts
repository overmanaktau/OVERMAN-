import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { requireKassa } from "@/lib/kassa/access";
import { computeBonus, ACTIVATION_DAYS, almatyDate } from "@/lib/kassa/bonus";
import { fetchClientBasic, fetchClientBonusTransactions, fetchClientDocs } from "@/lib/moysklad";
import { REGISTER_STORE } from "@/lib/registers";
import { todayAlmaty } from "@/lib/kassa/sync";

export const maxDuration = 60;

const MS_APP = "https://online.moysklad.ru/app/#";
const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };

// Карточка клиента: свежие данные прямо из МойСклад (покупки и бонусы), чтобы сегодняшняя покупка сразу
// учитывалась в индикаторе. История со ссылками на чеки, бонусы по партиям.
export async function GET(request: Request) {
  const caller = await requireKassa(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Неверный клиент." }, { status: 400 });
  try {
    const [client, tx, docs] = await Promise.all([fetchClientBasic(id), fetchClientBonusTransactions(id), fetchClientDocs(id)]);
    if (!client) return NextResponse.json({ error: "Клиент не найден." }, { status: 404 });
    const today = todayAlmaty();
    const returnDemand = new Map(docs.returns.filter((r) => r.demandId).map((r) => [r.id, r.demandId as string]));
    const bonus = computeBonus(
      tx.map((t) => ({ id: t.id, moment: t.moment, value: t.value, kind: t.kind, status: t.status, parentType: t.parentType, parentId: t.parentId })),
      returnDemand,
      today
    );

    const earnedBy = new Map<string, number>();
    const spentBy = new Map<string, number>();
    for (const t of tx) {
      if (t.status !== "COMPLETED") continue;
      const m = t.kind === "earn" ? earnedBy : spentBy;
      m.set(t.parentId, (m.get(t.parentId) ?? 0) + t.value);
    }
    const lotByParent = new Map(bonus.lots.map((l) => [l.parentId, l]));
    const plusDays = (date: string, n: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
    const purchases = [
      ...docs.demands.map((d) => {
        const lot = lotByParent.get(d.id);
        return {
          kind: "sale" as const,
          id: d.id,
          name: d.name,
          at: d.moment,
          sum: d.sum,
          city: CITY[REGISTER_STORE[d.retailStoreId] ?? ""] ?? "",
          earned: earnedBy.get(d.id) ?? 0,
          spent: spentBy.get(d.id) ?? 0,
          // бонусы этой покупки: ждут активации до даты, активны, уже потрачены или не начислялись
          activatesOn: lot?.activatesOn ?? plusDays(almatyDate(d.moment), ACTIVATION_DAYS),
          lotState: lot ? (lot.remaining > 0 ? lot.state : "used") : earnedBy.get(d.id) ? "used" : "none",
          link: `${MS_APP}retaildemand/edit?id=${d.id}`,
        };
      }),
      ...docs.returns.map((r) => ({
        kind: "return" as const,
        id: r.id,
        name: r.name,
        at: r.moment,
        sum: -r.sum,
        city: CITY[REGISTER_STORE[r.retailStoreId] ?? ""] ?? "",
        earned: 0,
        spent: spentBy.get(r.id) ?? 0,
        activatesOn: "",
        lotState: "none",
        link: `${MS_APP}retailsalesreturn/edit?id=${r.id}`,
      })),
    ].sort((a, b) => b.at.localeCompare(a.at));

    // список кассы обновляем свежими цифрами, чтобы он не расходился с карточкой до ночи
    await supabaseAdmin
      .from("kassa_clients")
      .update({ bonus_balance: bonus.balance, bonus_available: bonus.available, bonus_waiting: bonus.waiting, bonus_next_activation: bonus.nextActivation, bonus_expired: bonus.expired })
      .eq("ms_id", id);

    return NextResponse.json({
      client: { id: client.id, name: client.name, phone: client.phone },
      bonus: { balance: bonus.balance, available: bonus.available, waiting: bonus.waiting, nextActivation: bonus.nextActivation, expired: bonus.expired },
      returning: docs.demands.length > 1,
      purchases,
    });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
