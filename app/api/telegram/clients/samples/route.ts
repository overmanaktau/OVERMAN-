import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { handleClientUpdate } from "@/lib/clientBotHandler";
import { telegramClientTransport } from "@/lib/clientBot";
import { activatedMessage, expiredMessage, expiringSoonMessage, purchaseMessage } from "@/lib/clientBotMessages";

// Разовая отправка владельцу всего пути клиента в боте: /start, номер, образцы сообщений. После показа маршрут удаляется.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const to = Number(params.get("to"));
  const phone = params.get("phone") ?? "";
  if (!Number.isInteger(to) || !phone) return NextResponse.json({ error: "Нужны to и phone." }, { status: 400 });
  const chat = { id: to, type: "private" };
  const from = { id: to, first_name: "Акыл" };
  await handleClientUpdate({ message: { chat, from, text: "/start" } }, telegramClientTransport);
  await wait(1500);
  await handleClientUpdate({ message: { chat, from, contact: { phone_number: phone, user_id: to } } }, telegramClientTransport);
  await wait(1500);
  const samples = [
    ["Үлгі 1 — сатып алу, бонус жұмсалмаған", purchaseMessage({ earned: 1250, activatesOn: "03.11.2026", available: 3400, pending: 1250 })],
    ["Үлгі 2 — сатып алу, бонус жұмсалған", purchaseMessage({ earned: 800, activatesOn: "03.11.2026", spent: 2000, available: 1400, pending: 2050 })],
    ["Үлгі 3 — бонус белсендірілген күн", activatedMessage(4650)],
    ["Үлгі 4 — жойылуына 14 күн қалғанда", expiringSoonMessage(800, "03.11.2026")],
    ["Үлгі 5 — жойылған күн", expiredMessage(800, 3850)],
  ];
  for (const [title, text] of samples) {
    await telegramClientTransport.send(to, `<i>${title}</i>\n\n${text}`);
    await wait(500);
  }
  await supabaseAdmin.from("client_bot_subscribers").delete().eq("telegram_user_id", to);
  return NextResponse.json({ ok: true, sent: samples.length + 2 });
}
