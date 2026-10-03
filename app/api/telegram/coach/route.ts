import { NextResponse } from "next/server";
import { handleUpdate, type TgUpdate } from "@/lib/coach/handler";
import { telegramTransport, webhookSecret, type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { getErrorMessage } from "@/lib/errors";

export const maxDuration = 60;

// Вебхук бота-помощника продавцов. Telegram шлёт сюда каждое сообщение и
// нажатие кнопки, подписывая запрос секретом (webhookSecret). Для проверки без
// токена бота есть режим ?mock=1 — только с CRON_SECRET, ответы бота не
// отправляются, а возвращаются в ответе.
export async function POST(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get("mock") === "1") {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
    }
    const sent: { chat: number | string; html: string; markup?: ReplyMarkup }[] = [];
    const deleted: { chat: number | string; messageId: number }[] = [];
    const cleared: { chat: number | string; messageId: number }[] = [];
    const mock: Transport = {
      async send(chat, html, markup) {
        sent.push({ chat, html, markup });
      },
      async answerCallback() {},
      async deleteMessage(chat, messageId) {
        deleted.push({ chat, messageId });
      },
      async clearButtons(chat, messageId) {
        cleared.push({ chat, messageId });
      },
    };
    try {
      await handleUpdate((await request.json()) as TgUpdate, mock);
      return NextResponse.json({ ok: true, sent, deleted, cleared });
    } catch (e) {
      return NextResponse.json({ error: getErrorMessage(e), sent, deleted, cleared }, { status: 500 });
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
    await handleUpdate((await request.json()) as TgUpdate, telegramTransport);
  } catch (e) {
    // Telegram повторяет запрос, пока не получит 200, — чтобы одна ошибка не
    // зациклила обработку, отвечаем 200 и пишем причину в лог.
    console.error("coach webhook error:", getErrorMessage(e));
  }
  return NextResponse.json({ ok: true });
}
