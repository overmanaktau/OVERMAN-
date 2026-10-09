import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { todayInAlmaty } from "@/lib/coach/metrics";
import { buildWeeklyComparePdf, loadWeeklyCompare } from "@/lib/reports/weeklyCompare";

export const maxDuration = 60;

// PDF «Сравнение недель»: две недели по дням, итоги и разница. Только с CRON_SECRET.
// ?store=point_1|point_3, ?from=YYYY-MM-DD — понедельник первой недели (по умолчанию две последние полные недели).
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const store = url.searchParams.get("store") ?? "point_1";
  const from = url.searchParams.get("from") ?? undefined;
  if (!["point_1", "point_3"].includes(store) || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from))) {
    return NextResponse.json({ error: "Неверные параметры." }, { status: 400 });
  }
  try {
    const { weeks, city } = await loadWeeklyCompare(store, todayInAlmaty(), from);
    const pdf = await buildWeeklyComparePdf(weeks, city);
    return new NextResponse(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="weeks-${store}.pdf"` } });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}
