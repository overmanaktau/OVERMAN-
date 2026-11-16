import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { sendCoachDocument } from "@/lib/coach/bot";

export const maxDuration = 60;

// Временный маршрут: отправить PDF лично пользователю через бота-помощника. Только с CRON_SECRET: ?user=<id>&name=<имя файла>&caption=<подпись>, тело — байты PDF.
export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("user"));
  const name = url.searchParams.get("name") ?? "report.pdf";
  const caption = url.searchParams.get("caption") ?? undefined;
  if (!userId) return NextResponse.json({ error: "Неверные параметры." }, { status: 400 });
  try {
    const { data: user, error } = await supabaseAdmin.from("coach_users").select("telegram_chat_id").eq("id", userId).eq("status", "approved").maybeSingle();
    if (error) throw error;
    if (!user) return NextResponse.json({ error: "Пользователь не найден." }, { status: 404 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const id = await sendCoachDocument(user.telegram_chat_id, name, bytes, caption);
    return NextResponse.json({ sent: true, message_id: id });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
