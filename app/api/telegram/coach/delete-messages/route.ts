import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { coachApi } from "@/lib/coach/bot";

// Удалить сообщения бота-помощника в личном чате сотрудника по их номерам (если бот отправил лишнее).
// Только с CRON_SECRET. ?user=<id в coach_users>&ids=291,292 (не больше 10 номеров; Telegram разрешает
// боту удалять свои сообщения не старше 48 часов).
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("user"));
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!userId || ids.length === 0 || ids.length > 10) return NextResponse.json({ error: "Неверные параметры." }, { status: 400 });
  try {
    const { data: user, error } = await supabaseAdmin.from("coach_users").select("telegram_chat_id, employee_name").eq("id", userId).eq("status", "approved").maybeSingle();
    if (error) throw error;
    if (!user) return NextResponse.json({ error: "Пользователь не найден." }, { status: 404 });
    const results: { id: number; ok: boolean; description?: string }[] = [];
    for (const id of ids) {
      const r = await coachApi("deleteMessage", { chat_id: user.telegram_chat_id, message_id: id });
      results.push({ id, ok: r.ok, description: r.ok ? undefined : r.description });
    }
    return NextResponse.json({ user: user.employee_name, results });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
