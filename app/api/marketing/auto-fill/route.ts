import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { yesterdayInAlmaty } from "@/lib/reports/sales";
import { autoFillMarketing, notifyFilled } from "@/lib/marketing/autoFill";

export const maxDuration = 60;

// Ручной запуск автозаполнения «Внесение данных» (Instagram по расходу Meta × курс МиГ, 2ГИС Актау): только с CRON_SECRET.
// ?date=YYYY-MM-DD — другой день (по умолчанию вчера); ?dry=1 — только посчитать и показать, ничего не вносить.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? yesterdayInAlmaty();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });
  const dry = url.searchParams.get("dry") === "1";
  try {
    const r = await autoFillMarketing(date, dry);
    if (!dry && r.rate) await notifyFilled(date, r.rate, r.results);
    return NextResponse.json({ ok: true, dry, ...r });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
