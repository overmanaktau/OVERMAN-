import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { MENU_MARKUP, telegramTransport } from "@/lib/coach/bot";

export const maxDuration = 60;

// ОДНОРАЗОВО: сообщение подтверждённым стилистам-консультантам о том, что меню поменялось.
// Вместе с сообщением приходит новая клавиатура (Помощь / Выход), поэтому старая заменяется
// сразу. Повторный запуск никому не шлёт второй раз (запись в coach_messages_sent).
// ?dry=1 — только показать, кому уйдёт. Авторизация — CRON_SECRET.
const KIND = "announce-menu-2026-10-05";
const REF_DATE = "2026-10-05";
const TEXT = [
  "📣 <b>Меню бота изменилось</b>",
  "",
  "Кнопки «Мой план», «Что повысить», «План на неделю» и «Итоги прошлой недели» убрали — смотреть план и продажи вручную больше не нужно.",
  "",
  "Теперь бот сам присылает вам:",
  "• <b>утром после смены</b> — итоги смены, как идёт месяц, сколько нужно в среднем за смену и что повысить;",
  "• <b>каждый понедельник утром</b> — план на неделю и итоги прошлой недели.",
  "",
  "Внизу остались две кнопки: «Помощь» и «Выход».",
].join("\n");

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  try {
    const { data, error } = await supabaseAdmin
      .from("coach_users")
      .select("id, employee_name, telegram_chat_id")
      .eq("status", "approved")
      .eq("is_admin", false)
      .eq("is_test", false);
    if (error) throw error;

    const results: { user: string; action: string }[] = [];
    for (const u of (data ?? []) as { id: number; employee_name: string; telegram_chat_id: number }[]) {
      const { data: already } = await supabaseAdmin
        .from("coach_messages_sent")
        .select("id")
        .eq("user_id", u.id)
        .eq("kind", KIND)
        .eq("ref_date", REF_DATE)
        .maybeSingle();
      if (already) {
        results.push({ user: u.employee_name, action: "уже отправлено" });
        continue;
      }
      if (dry) {
        results.push({ user: u.employee_name, action: "получит сообщение" });
        continue;
      }
      try {
        await telegramTransport.send(u.telegram_chat_id, TEXT, MENU_MARKUP);
        await supabaseAdmin.from("coach_messages_sent").insert({ user_id: u.id, kind: KIND, ref_date: REF_DATE });
        results.push({ user: u.employee_name, action: "отправлено" });
      } catch (e) {
        results.push({ user: u.employee_name, action: `ошибка: ${getErrorMessage(e)}` });
      }
    }
    return NextResponse.json({ ok: true, dry, results });
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
