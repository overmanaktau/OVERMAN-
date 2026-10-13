import { NextResponse } from "next/server";
import { handleClientUpdate, type ClientTgUpdate } from "@/lib/clientBotHandler";
import { telegramClientTransport, webhookSecret, type ClientTransport, type ReplyMarkup } from "@/lib/clientBot";
import { getErrorMessage } from "@/lib/errors";

export const maxDuration = 60;

// Вебхук бота для клиентов. Telegram шлёт сюда сообщения, подписывая запрос секретом (webhookSecret). Для проверки без
// токена бота есть режим ?mock=1 — только с CRON_SECRET: ответы бота не отправляются, а возвращаются в ответе.
export async function POST(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get("mock") === "1") {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
    }
    const sent: { chat: number; html: string; markup?: ReplyMarkup }[] = [];
    const mock: ClientTransport = {
      async send(chat, html, markup) {
        sent.push({ chat, html, markup });
      },
    };
    try {
      await handleClientUpdate((await request.json()) as ClientTgUpdate, mock);
      return NextResponse.json({ ok: true, sent });
    } catch (e) {
      return NextResponse.json({ error: getErrorMessage(e), sent }, { status: 500 });
    }
  }

  let secretOk = false;
  try {
    secretOk = request.headers.get("x-telegram-bot-api-secret-token") === webhookSecret();
  } catch {
    secretOk = false; // токен бота не задан
  }
  if (!secretOk) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });

  try {
    await handleClientUpdate((await request.json()) as ClientTgUpdate, telegramClientTransport);
  } catch (e) {
    // Telegram повторяет запрос, пока не получит 200 — чтобы одна ошибка не зациклила обработку, отвечаем 200 и пишем в лог.
    console.error("clients bot webhook error:", getErrorMessage(e));
  }
  return NextResponse.json({ ok: true });
}
