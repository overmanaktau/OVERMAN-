import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { buildDailyChanges } from "@/lib/verify/dailyChanges";

export const maxDuration = 60;

// Ночная сводка владельцу «что изменилось за последние сутки» (pg_cron, 04:30 по Алматы) — в личку бота-помощника.
// ?dry=1 — вернуть текст и ничего не отправлять; ?hours=N — окно (по умолчанию 24 часа до текущего момента).
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const hours = Math.min(Math.max(Number(url.searchParams.get("hours") ?? 24) || 24, 1), 24 * 14);
  try {
    const until = new Date();
    const since = new Date(until.getTime() - hours * 3600000);
    const result = await buildDailyChanges(since.toISOString(), until.toISOString());
    if (dry) return NextResponse.json({ ok: true, dry: true, ...result });
    for (const m of result.messages) {
      await notifyOwner(m);
      await new Promise((r) => setTimeout(r, 400));
    }
    return NextResponse.json({ ok: true, sent: result.messages.length, empty: result.empty, errors: result.errors });
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
