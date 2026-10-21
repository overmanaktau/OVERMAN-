import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { fetchDocAgentId, fetchDemandIdOfReturn } from "@/lib/moysklad";
import { syncOneClient } from "@/lib/kassa/clientSync";
import { notifyAfterPurchase } from "@/lib/clientBotNotify";
import { syncAccrual } from "@/lib/kassa/accrual";

export const maxDuration = 60;

// Обработка очереди уведомлений МойСклад: для каждого нового чека или возврата узнаём покупателя и обновляем его данные на экране /client
// (бонусы по партиям, последняя покупка). Пустая очередь — ни одного запроса к МойСклад. Запускается сразу после уведомления и расписанием раз в минуту.
async function handle(request: Request) {
  const cron = process.env.CRON_SECRET;
  if (!cron || (request.headers.get("authorization") ?? "") !== `Bearer ${cron}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });

  try {
    const { data: pending, error } = await supabaseAdmin.from("ms_webhook_events").select("id").is("processed_at", null).order("id").limit(100);
    if (error) throw error;
    if (!pending || pending.length === 0) return NextResponse.json({ ok: true, events: 0, clients: 0 });

    // забираем события себе: параллельный запуск (сразу после уведомления и по расписанию) не обработает их второй раз
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("ms_webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .in("id", pending.map((r) => r.id))
      .is("processed_at", null)
      .select("id, href");
    if (claimError) throw claimError;
    if (!claimed || claimed.length === 0) return NextResponse.json({ ok: true, events: 0, clients: 0 });

    // один документ — один запрос; один покупатель — одно обновление, сколько бы событий по нему ни пришло
    const hrefs = [...new Set(claimed.map((r) => r.href as string))];
    const clientByHref = new Map<string, string | null>();
    const errors = new Map<string, string>();
    for (const href of hrefs) {
      try {
        clientByHref.set(href, await fetchDocAgentId(href));
      } catch (e) {
        clientByHref.set(href, null);
        errors.set(href, getErrorMessage(e));
      }
    }
    // чеки, по которым пересчитывается бонус: сам чек или чек, к которому относится возврат (начисление считает портал, см. lib/kassa/accrual.ts)
    const demandsByClient = new Map<string, Set<string>>();
    for (const href of hrefs) {
      const cid = clientByHref.get(href);
      if (!cid) continue;
      const docId = href.split("?")[0].split("/").pop() ?? "";
      try {
        const demandId = href.includes("/retailsalesreturn/") ? await fetchDemandIdOfReturn(docId) : href.includes("/retaildemand/") ? docId : null;
        if (demandId) demandsByClient.set(cid, (demandsByClient.get(cid) ?? new Set<string>()).add(demandId));
      } catch (e) {
        errors.set(href, getErrorMessage(e));
      }
    }
    const clientIds = [...new Set([...clientByHref.values()].filter((v): v is string => !!v))];
    const results: Record<string, string> = {};
    for (const id of clientIds) {
      try {
        let r = await syncOneClient(id);
        results[id] = r.status;
        if (r.status === "updated") {
          // пересчёт начисления по чекам клиента; если что-то записано — клиента пересчитываем ещё раз, чтобы «ожидает активации» уже учитывало новый бонус
          let changed = false;
          for (const demandId of demandsByClient.get(id) ?? []) {
            try {
              if ((await syncAccrual(demandId)) === "ok") changed = true;
            } catch (e) {
              console.error("accrual sync error:", getErrorMessage(e));
            }
          }
          if (changed) r = await syncOneClient(id);
        }
        // подписанному клиенту — сообщение о бонусах за покупку; сбой отправки не должен ломать обработку очереди
        if (r.status === "updated") await notifyAfterPurchase(id).catch((e) => console.error("client bot notify error:", getErrorMessage(e)));
      } catch (e) {
        results[id] = `ошибка: ${getErrorMessage(e)}`;
        for (const [href, cid] of clientByHref) if (cid === id) errors.set(href, getErrorMessage(e));
      }
    }
    for (const r of claimed) {
      const href = r.href as string;
      await supabaseAdmin
        .from("ms_webhook_events")
        .update({ client_ms_id: clientByHref.get(href) ?? null, error: errors.get(href) ?? null })
        .eq("id", r.id);
    }
    return NextResponse.json({ ok: true, events: claimed.length, clients: clientIds.length, results });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
