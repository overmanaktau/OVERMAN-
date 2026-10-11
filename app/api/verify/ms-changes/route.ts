import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { checkMsChanges } from "@/lib/verify/msChanges";

export const maxDuration = 300;

// Проверка журнала изменений МойСклад (pg_cron: ночью до сверки и утром до отчётов; вручную — админ).
// ?dry=1 — только посмотреть (ничего не пересчитывать и не сдвигать курсор), ?since=ГГГГ-ММ-ДД ЧЧ:ММ:СС — с какого момента читать журнал.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const since = url.searchParams.get("since") ?? undefined;
  if (since && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(since)) return NextResponse.json({ error: "Неверное since." }, { status: 400 });
  try {
    const secret = cronSecret ?? "";
    const result = await checkMsChanges({ origin: url.origin, secret, since, apply: !dry, notify: url.searchParams.get("notify") !== "0" });
    return NextResponse.json({ ok: true, dry, ...result });
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
