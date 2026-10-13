import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { webhookToken } from "@/lib/msWebhook";

export const maxDuration = 10;

type MsEvent = { meta?: { type?: string; href?: string }; action?: string };

// Веб-хук МойСклад: чек или возврат создан/изменён. Только записываем событие и сразу отвечаем (МойСклад ждёт ответ недолго);
// обработка — в /api/moysklad/process-events: её запускаем сразу, а страхует расписание раз в минуту.
export async function POST(request: Request) {
  let ok = false;
  try {
    ok = new URL(request.url).searchParams.get("token") === webhookToken();
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });

  try {
    const body = (await request.json()) as { events?: MsEvent[] };
    const rows = (body.events ?? [])
      .filter((e) => (e.meta?.type === "retaildemand" || e.meta?.type === "retailsalesreturn") && (e.action === "CREATE" || e.action === "UPDATE") && e.meta?.href)
      .map((e) => ({ entity_type: e.meta!.type as string, action: e.action as string, href: e.meta!.href as string }));
    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from("ms_webhook_events").insert(rows);
      if (error) throw error;
      // сразу запускаем обработку, не дожидаясь расписания (не ждём результата — МойСклад нельзя держать)
      const cron = process.env.CRON_SECRET;
      if (cron) {
        try {
          await fetch(new URL("/api/moysklad/process-events", request.url), { headers: { Authorization: `Bearer ${cron}` }, signal: AbortSignal.timeout(1500) });
        } catch {
          // обработчик продолжит работу сам или подхватит расписание
        }
      }
    }
  } catch (e) {
    console.error("moysklad webhook error:", getErrorMessage(e));
  }
  return NextResponse.json({ ok: true });
}
