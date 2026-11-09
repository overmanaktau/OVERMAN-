import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { yesterdayInAlmaty } from "@/lib/reports/sales";
import { buildBonusMessage, computeAktauBonus, sendAktauBonusToNurzhan } from "@/lib/bonus/aktauBonus";
import { askOnlineQuestions } from "@/lib/onlineCheck";

export const maxDuration = 60;

// Бонусы по Актау за день (командный и за чеки): только с CRON_SECRET.
// ?date=YYYY-MM-DD — другой день (по умолчанию вчера); ?dry=1 — показать расчёт и текст сообщения, никому не отправлять; без dry — отправить Нуржану (один раз за день).
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? yesterdayInAlmaty();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });
  try {
    if (url.searchParams.get("dry") === "1") {
      const day = await computeAktauBonus(date);
      return NextResponse.json({ ok: true, dry: true, day, text: buildBonusMessage(day), questions: (await askOnlineQuestions(date, true)).checks });
    }
    return NextResponse.json({ ok: true, ...(await sendAktauBonusToNurzhan(date)) });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
