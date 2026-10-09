import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendCoachDocument } from "@/lib/coach/bot";
import { todayInAlmaty } from "@/lib/coach/metrics";
import { buildWeeklyComparePdf, loadWeeklyCompare } from "@/lib/reports/weeklyCompare";

export const maxDuration = 60;

// PDF «Сравнение недель»: две недели по дням, итоги и разница. Только с CRON_SECRET.
// ?store=point_1|point_3, ?from=YYYY-MM-DD — понедельник первой недели (по умолчанию две последние полные недели).
// ?send=<id в coach_users> — не отдавать файл, а отправить его этому сотруднику лично через бота-помощника
// (так по понедельникам в 9:00 PDF уходит Картбаеву Нуржану).
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
    const sendTo = Number(url.searchParams.get("send"));
    if (sendTo) {
      const { data: user, error } = await supabaseAdmin.from("coach_users").select("telegram_chat_id, employee_name").eq("id", sendTo).eq("status", "approved").maybeSingle();
      if (error) throw error;
      if (!user) return NextResponse.json({ error: "Пользователь не найден." }, { status: 404 });
      const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
      await sendCoachDocument(
        user.telegram_chat_id,
        `Сравнение_недель_${city}_${weeks[1].to}.pdf`,
        pdf,
        `Сравнение недель · ${city}: ${fmt(weeks[0].from)}–${fmt(weeks[0].to)} и ${fmt(weeks[1].from)}–${fmt(weeks[1].to)}`
      );
      return NextResponse.json({ sent: true, to: user.employee_name, weeks: [weeks[0].from, weeks[1].from] });
    }
    return new NextResponse(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="weeks-${store}.pdf"` } });
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
