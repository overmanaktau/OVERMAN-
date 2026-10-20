import { NextResponse } from "next/server";
import { telegramClientTransport } from "@/lib/clientBot";
import { activatedMessage, expiredMessage, expiringSoonMessage, purchaseMessage } from "@/lib/clientBotMessages";

// Разовая отправка образцов сообщений владельцу (CRON_SECRET, ?to=<chat id>). После показа маршрут удаляется.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const to = Number(new URL(request.url).searchParams.get("to"));
  if (!Number.isInteger(to)) return NextResponse.json({ error: "Нужен to." }, { status: 400 });
  const samples = [
    ["Образец 1 — покупка без списания", purchaseMessage({ earned: 1250, activatesOn: "03.11.2026", available: 3400, pending: 1250 })],
    ["Образец 2 — покупка со списанием бонусов", purchaseMessage({ earned: 800, activatesOn: "03.11.2026", spent: 2000, available: 1400, pending: 2050 })],
    ["Образец 3 — день активации", activatedMessage(1250, 4650)],
    ["Образец 4 — за 14 дней до сгорания", expiringSoonMessage(800, "03.11.2026")],
    ["Образец 5 — день сгорания", expiredMessage(800, 3850)],
  ];
  for (const [title, text] of samples) {
    await telegramClientTransport.send(to, `<i>${title}</i>\n\n${text}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  return NextResponse.json({ ok: true, sent: samples.length });
}
