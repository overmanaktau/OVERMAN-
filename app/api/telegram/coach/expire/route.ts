import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { telegramTransport } from "@/lib/coach/bot";
import { expireTestUser } from "@/lib/coach/testmode";

export const maxDuration = 60;

// Вывод тестовых аккаунтов, у которых истекли 30 минут (расписание pg_cron,
// каждые 2 минуты). Каждому уходит сообщение, регистрация начинается заново.
// Сам бот тоже проверяет срок при любом нажатии — это только «будильник».
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from("coach_users")
      .select("id, telegram_chat_id")
      .eq("is_test", true)
      .eq("status", "approved")
      .lte("test_expires_at", new Date().toISOString());
    if (error) throw error;
    let expired = 0;
    for (const u of (data ?? []) as { id: number; telegram_chat_id: number }[]) {
      await expireTestUser(u, telegramTransport);
      expired += 1;
    }
    return NextResponse.json({ ok: true, expired });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
