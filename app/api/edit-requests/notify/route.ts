import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { webhookToken } from "@/lib/msWebhook";
import { notifyNewEditRequest } from "@/lib/editRequests";

export const maxDuration = 15;

// Вызывается базой сразу после создания запроса (триггер на edit_requests): шлёт владельцу сообщение с кнопками «Одобрить»/«Отклонить».
// Секрет — в адресе (token, выводится из CRON_SECRET); сам по себе он может только повторно отправить сообщение о существующем запросе.
export async function POST(request: Request) {
  let ok = false;
  try {
    ok = new URL(request.url).searchParams.get("token") === webhookToken();
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  try {
    const body = (await request.json()) as { id?: number };
    const id = Number(body.id);
    if (!Number.isInteger(id)) return NextResponse.json({ error: "Неверный запрос." }, { status: 400 });
    return NextResponse.json({ ok: true, sent: await notifyNewEditRequest(id) });
  } catch (e) {
    // сообщение — только удобство: ошибка не должна влиять на сам запрос
    console.error("edit request notify error:", getErrorMessage(e));
    return NextResponse.json({ ok: false });
  }
}
