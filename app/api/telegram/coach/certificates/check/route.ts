import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { telegramTransport, type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { checkCertificateReturns } from "@/lib/coach/certificates";
import { addDays, todayInAlmaty } from "@/lib/coach/metrics";
import { fetchRetailSalesReturnsForDate } from "@/lib/moysklad";

export const maxDuration = 60;

// Ночная проверка: не было ли возврата по чеку, к которому привязан использованный сертификат.
// Дёргается pg_cron после ночной синхронизации (CRON_SECRET) или вручную админом.
// ?date=YYYY-MM-DD — за другой день (по умолчанию вчера), ?dry=1 — сообщения владельцу не отправляются.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? addDays(todayInAlmaty(), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });
  const dry = url.searchParams.get("dry") === "1";

  const sent: { chat: number | string; html: string; markup?: ReplyMarkup }[] = [];
  const dryTransport: Transport = {
    async send(chat, html, markup) {
      sent.push({ chat, html, markup });
    },
    async answerCallback() {},
    async deleteMessage() {},
    async clearButtons() {},
  };
  try {
    const returns = await fetchRetailSalesReturnsForDate(date);
    const { matched } = await checkCertificateReturns(dry ? dryTransport : telegramTransport, date, returns);
    return NextResponse.json({ date, returns: returns.length, matched, ...(dry ? { sent } : {}) });
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
