import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { yesterdayInAlmaty } from "@/lib/reports/sales";
import { heldDates } from "@/lib/verify/holds";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { runVerification } from "@/lib/verify/run";

export const maxDuration = 300;

// Ночная сверка отчётов (расписание pg_cron, 03:30 по Алматы, до утренних отчётов в группы) и
// перепроверка задержанных отчётов (08:30, ?recheck=1). Цикл: сверка → автоисправление →
// повторная сверка. Если расхождение исправить не удалось, неправильный отчёт в группы НЕ
// отправляется (удержание, lib/verify/holds.ts), пока его не исправят или владелец не
// разрешит отправить как есть. Результат — ТОЛЬКО главному владельцу в личку бота-помощника,
// каждую ночь: «всё сходится», «исправлено», либо «отчёты задержаны» с кнопками.
// ?dry=1 — вернуть результат и текст без изменений и отправки, ?date=YYYY-MM-DD — сверить
// другой день, ?fix=0 — не исправлять автоматически.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const recheck = url.searchParams.get("recheck") === "1";
  const fix = url.searchParams.get("fix") !== "0";

  const dateParam = url.searchParams.get("date");
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });

  // Перепроверка — по всем дням, за которые отчёты сейчас задержаны.
  let dates: string[];
  try {
    dates = recheck ? await heldDates() : [dateParam ?? yesterdayInAlmaty()];
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
  if (recheck && dates.length === 0) return NextResponse.json({ ok: true, recheck: true, held: 0 });

  const summary: { date: string; ok: boolean; held: string[]; fixActions: string[]; sentReports: string[]; text?: string }[] = [];
  for (const date of dates) {
    try {
      const r = await runVerification({ origin: url.origin, secret: cronSecret, date, fix, recheck, dry });
      summary.push({ date, ok: r.result.ok, held: r.heldStores, fixActions: r.fixActions, sentReports: r.sentReports, ...(dry ? { text: r.text } : {}) });
      if (!dry) await notifyOwner(r.text, r.markup);
    } catch (e) {
      // Если сама сверка не смогла выполниться (например, МойСклад не отвечает), владелец тоже узнаёт.
      const text = `⚠️ <b>Сверка за ${date.split("-").reverse().join(".")} не выполнена</b>\nПричина: ${getErrorMessage(e)}\nОтчёты по этому дню не проверены.`;
      summary.push({ date, ok: false, held: [], fixActions: [], sentReports: [], text });
      if (!dry) await notifyOwner(text);
    }
  }
  return NextResponse.json({ ok: summary.every((s) => s.ok), dry, recheck, results: summary });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
