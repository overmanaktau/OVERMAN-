import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { syncCoachNames } from "@/lib/coach/syncNames";
import { syncEmployeeNamesEverywhere } from "@/lib/employeeNames";

// Подтянуть актуальные имена сотрудников из МойСклад в список бота-помощника.
// Вызывается страницей «Помощник консультантов» и вручную (CRON_SECRET или админ).
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  try {
    const result = await syncCoachNames();
    // ?history=1 — заодно привести имена в истории продаж и планах (вручную; ночью это делает синхронизация).
    const history = new URL(request.url).searchParams.get("history") === "1" ? await syncEmployeeNamesEverywhere() : undefined;
    return NextResponse.json({ ...result, ...(history ? { history } : {}) });
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
