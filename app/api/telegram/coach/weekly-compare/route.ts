import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { coachApi, sendCoachDocument } from "@/lib/coach/bot";
import { stable } from "@/lib/reports/stable";
import { activeHoldFor } from "@/lib/verify/holds";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { todayInAlmaty } from "@/lib/coach/metrics";
import { buildWeeklyComparePdf, loadWeeklyCompare } from "@/lib/reports/weeklyCompare";
import { buildPeriodsComparePdf } from "@/lib/coach/compareReport";

export const maxDuration = 60;

// PDF «Сравнение недель»: две недели по дням, итоги и разница. Только с CRON_SECRET.
// ?store=point_1|point_3, ?from=YYYY-MM-DD — понедельник первой недели (по умолчанию две последние полные недели).
// ?send=<id в coach_users> — не отдавать файл, а отправить его этому сотруднику лично через бота-помощника
// (так по понедельникам в 9:00 PDF уходит Картбаеву Нуржану).
// ?sendAdmins=1 — отправить всем подтверждённым администраторам города (is_admin, admin_scope = city, их store = ?store);
// так PDF по Актобе уходит Айдане, как только она зарегистрируется в боте. Нет ни одного — пишем владельцу.
// ?replace=1 (вместе с send / sendAdmins) — после отправки удалить прежние копии этого же PDF в том же чате: среди
// 6 сообщений перед новым ищем документы с точно такой же подписью (повторное редактирование подписи тем же текстом
// Telegram отклоняет как «не изменено» — так отличаем свой PDF от других сообщений, ничего не меняя).
async function removeOlderCopies(chatId: number | string, newId: number | null, caption: string): Promise<number> {
  if (!newId) return 0;
  let removed = 0;
  for (let id = newId - 1; id > Math.max(newId - 7, 0); id--) {
    const r = await coachApi("editMessageCaption", { chat_id: chatId, message_id: id, caption });
    if (!r.ok && /not modified/i.test(r.description ?? "")) {
      const del = await coachApi("deleteMessage", { chat_id: chatId, message_id: id });
      if (del.ok) removed += 1;
    }
  }
  return removed;
}

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
  // ?p1=YYYY-MM-DD..YYYY-MM-DD&p2=… — сравнение двух произвольных периодов (как кнопка «Отчёт» в боте), файл отдаётся сразу.
  const p1 = url.searchParams.get("p1")?.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  const p2 = url.searchParams.get("p2")?.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (p1 && p2) {
    try {
      const { pdf } = await buildPeriodsComparePdf(store, { from: p1[1], to: p1[2] }, { from: p2[1], to: p2[2] });
      return new NextResponse(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="periods-${store}.pdf"` } });
    } catch (e) {
      return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
  }
  try {
    // Контрольный пересчёт данных: два независимых подсчёта, не совпали — третий; нет двух одинаковых — не отправляем.
    const checked = await stable(() => loadWeeklyCompare(store, todayInAlmaty(), from), (v) => JSON.stringify(v));
    if (!checked.ok) {
      if (url.searchParams.get("send")) await notifyOwner(`⏸ <b>PDF «Сравнение недель» не отправлен</b>
Контрольный пересчёт: ${checked.reason}. Данным верить нельзя.`);
      return NextResponse.json({ error: `контрольный пересчёт: ${checked.reason}` }, { status: 409 });
    }
    const { weeks, city } = checked.value;
    // Неисправленное расхождение за любой из 14 дней — неправильный отчёт не отправляем (как у групповых отчётов).
    const hold = await activeHoldFor([store], { from: weeks[0].from, to: weeks[1].to });
    if (hold && url.searchParams.get("send")) {
      await notifyOwner(`⏸ <b>PDF «Сравнение недель» не отправлен</b>
Не исправлено расхождение за ${hold.check_date.split("-").reverse().join(".")}. Как только его исправят, отправьте PDF вручную или дождитесь следующего понедельника.`);
      return NextResponse.json({ held: `расхождение за ${hold.check_date}` }, { status: 409 });
    }
    const pdf = await buildWeeklyComparePdf(weeks, city);
    const sendTo = Number(url.searchParams.get("send"));
    const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    const fileName = `Сравнение_недель_${city}_${weeks[1].to}.pdf`;
    const caption = `Сравнение недель · ${city}: ${fmt(weeks[0].from)}–${fmt(weeks[0].to)} и ${fmt(weeks[1].from)}–${fmt(weeks[1].to)}`;
    if (sendTo) {
      const { data: user, error } = await supabaseAdmin.from("coach_users").select("telegram_chat_id, employee_name").eq("id", sendTo).eq("status", "approved").maybeSingle();
      if (error) throw error;
      if (!user) return NextResponse.json({ error: "Пользователь не найден." }, { status: 404 });
      const newId = await sendCoachDocument(user.telegram_chat_id, fileName, pdf, caption);
      const removed = url.searchParams.get("replace") === "1" ? await removeOlderCopies(user.telegram_chat_id, newId, caption) : 0;
      return NextResponse.json({ sent: true, to: user.employee_name, weeks: [weeks[0].from, weeks[1].from], messageId: newId, removedOld: removed });
    }
    if (url.searchParams.get("sendAdmins") === "1") {
      const { data: admins, error } = await supabaseAdmin
        .from("coach_users")
        .select("telegram_chat_id, employee_name")
        .eq("status", "approved")
        .eq("is_admin", true)
        .eq("admin_scope", "city")
        .eq("store", store);
      if (error) throw error;
      if (!admins || admins.length === 0) {
        await notifyOwner(`⏸ <b>PDF «Сравнение недель» (${city}) не отправлен</b>
Нет подтверждённого администратора города в боте-помощнике: администратор ещё не зарегистрировался или заявку не подтвердили.`);
        return NextResponse.json({ sent: false, reason: "нет администратора города" }, { status: 404 });
      }
      for (const admin of admins) {
        const newId = await sendCoachDocument(admin.telegram_chat_id, fileName, pdf, caption);
        if (url.searchParams.get("replace") === "1") await removeOlderCopies(admin.telegram_chat_id, newId, caption);
      }
      return NextResponse.json({ sent: true, to: admins.map((a) => a.employee_name), weeks: [weeks[0].from, weeks[1].from] });
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
