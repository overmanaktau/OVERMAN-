import { NextResponse } from "next/server";
import { handleSmmUpdate, type SmmUpdate } from "@/lib/smm/handler";
import { telegramTransport, webhookSecret, type ReplyMarkup, type Transport } from "@/lib/smm/telegram";
import { getErrorMessage } from "@/lib/errors";

export const maxDuration = 60;

// Вебхук бота для СММ. Telegram шлёт сюда сообщения и нажатия кнопок, подписывая запрос секретом (webhookSecret). Для проверки без
// отправки в Telegram есть режим ?mock=1 — только с CRON_SECRET: ответы бота не отправляются, а возвращаются в ответе.
export async function POST(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get("mock") === "1") {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
    const sent: { chat: number; kind: string; text: string; markup?: ReplyMarkup }[] = [];
    const mock: Transport = {
      async send(chat, html, markup) {
        sent.push({ chat, kind: "text", text: html, markup });
        return 1;
      },
      async photo(chat, photoUrl, caption, markup) {
        sent.push({ chat, kind: "photo", text: `${caption}\n[фото: ${photoUrl.slice(0, 60)}…]`, markup });
        return 1;
      },
      async edit(chat, _id, html, markup) {
        sent.push({ chat, kind: "edit", text: html, markup });
      },
      async answer() {},
    };
    try {
      await handleSmmUpdate((await request.json()) as SmmUpdate, mock);
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
    await handleSmmUpdate((await request.json()) as SmmUpdate, telegramTransport);
  } catch (e) {
    // Telegram повторяет запрос, пока не получит 200 — чтобы одна ошибка не зациклила обработку, отвечаем 200 и пишем в лог.
    console.error("smm bot webhook error:", getErrorMessage(e));
  }
  return NextResponse.json({ ok: true });
}
