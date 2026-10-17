import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { escapeHtml } from "@/lib/telegram";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { refOf, type CoachUser } from "@/lib/coach/handler";
import { addDays, mondayOf, shortDate, todayInAlmaty } from "@/lib/coach/metrics";
import { buildDailyText, buildWeeklyText } from "@/lib/coach/notifyBuild";

export const maxDuration = 300;

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };

// Выгрузка владельцу всех сообщений, которые за неделю ушли стилистам (итоги смены и недельные). Тексты сообщений в базе не хранятся,
// поэтому они считаются заново на дату отправки: ?from=YYYY-MM-DD — с какого дня (по умолчанию понедельник этой недели), ?dry=1 — не отправлять,
// а вернуть тексты. Запускается один раз по расписанию (pg_cron), результат — в личку владельца в боте-помощнике.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const dry = params.get("dry") === "1";
  const today = todayInAlmaty();
  const fromParam = params.get("from");
  const from = fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : mondayOf(today);

  try {
    // сообщения со времени «с 00:00 по Алматы» начала недели
    const since = new Date(`${from}T00:00:00+05:00`).toISOString();
    const { data, error } = await supabaseAdmin
      .from("coach_messages_sent")
      .select("user_id, kind, ref_date, sent_at, coach_users!inner(id, employee_ms_id, employee_name, store, is_test, telegram_chat_id)")
      .gte("sent_at", since)
      .order("sent_at", { ascending: true });
    if (error) throw error;
    type Row = { user_id: number; kind: string; ref_date: string; sent_at: string; coach_users: Pick<CoachUser, "id" | "employee_ms_id" | "employee_name" | "store" | "is_test" | "telegram_chat_id"> };
    const rows = ((data ?? []) as unknown as Row[]).filter((r) => !r.coach_users.is_test);

    const out: { head: string; text: string }[] = [];
    const errors: string[] = [];
    for (const r of rows) {
      const u = r.coach_users;
      const emp = refOf(u as CoachUser);
      // дата отправки по Алматы — относительно неё считались «вчера» и «сегодня»
      const sentDay = new Date(new Date(r.sent_at).getTime() + 5 * 3600000).toISOString().slice(0, 10);
      const sentTime = new Date(new Date(r.sent_at).getTime() + 5 * 3600000).toISOString().slice(11, 16);
      try {
        const text = r.kind === "weekly" ? await buildWeeklyText(emp, sentDay) : await buildDailyText(emp, sentDay);
        if (text) out.push({ head: `▶️ <b>${shortDate(sentDay)} ${sentTime}</b> · ${r.kind === "weekly" ? "недельное" : "итоги смены"} · ${escapeHtml(u.employee_name)} (${CITY[u.store] ?? u.store})`, text });
      } catch (e) {
        errors.push(`${u.employee_name} ${r.kind} ${r.ref_date}: ${getErrorMessage(e)}`);
      }
    }

    if (dry) return NextResponse.json({ ok: true, dry, from, count: out.length, errors, messages: out });

    await notifyOwner(
      `📬 <b>Сообщения стилистам за неделю</b>\n${shortDate(from)} – ${shortDate(addDays(from, 6))} · всего ${out.length}\n<i>Тексты не хранятся, поэтому они пересчитаны по данным на дату отправки в сегодняшнем формате: строки «План дня» и «Выполнение» в тех сообщениях ещё не было, а цифры могли чуть измениться, если данные поправляли.</i>`
    );
    for (const m of out) {
      await notifyOwner(`${m.head}\n\n${m.text}`);
      await new Promise((r) => setTimeout(r, 450));
    }
    if (errors.length > 0) await notifyOwner(`⚠️ Не удалось восстановить ${errors.length}:\n${errors.slice(0, 8).map(escapeHtml).join("\n")}`);
    return NextResponse.json({ ok: true, sent: out.length, errors });
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
