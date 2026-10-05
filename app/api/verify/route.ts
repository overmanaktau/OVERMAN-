import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { telegramTransport } from "@/lib/coach/bot";
import { reconcileDay, reconcileFixedMessage, reconcileMessage } from "@/lib/verify/reconcile";
import { autoFix } from "@/lib/verify/autofix";
import { yesterdayInAlmaty } from "@/lib/reports/sales";

export const maxDuration = 300;

// Ночная сверка отчётов (расписание pg_cron, 03:30 по Алматы, до утренних отчётов в группы).
// Результат уходит ТОЛЬКО главному владельцу в личку бота-помощника — и когда всё сходится,
// и когда есть расхождение. ?dry=1 — вернуть результат и текст без отправки,
// ?date=YYYY-MM-DD — сверить другой день, ?fix=0 — не исправлять автоматически.
// Если нашлось расхождение, система исправляет его сама (повторный пересчёт нужного шага),
// сверяет заново и сообщает владельцу итог. Авторизация — CRON_SECRET.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? yesterdayInAlmaty();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Неверная дата." }, { status: 400 });
  const dry = url.searchParams.get("dry") === "1";

  let text: string;
  let result: Awaited<ReturnType<typeof reconcileDay>> | null = null;
  let fixActions: string[] = [];
  try {
    result = await reconcileDay(date);
    text = reconcileMessage(result);
    // Нашли расхождение — исправляем сами (один раз), проверяем заново и сообщаем итог.
    // Ждать подтверждения владельца не нужно: отчёты в группы всё равно уходят в 9:00.
    if (!result.ok && !dry && url.searchParams.get("fix") !== "0") {
      fixActions = await autoFix(url.origin, cronSecret, date, result.checks.filter((c) => !c.ok));
      const after = await reconcileDay(date);
      text = reconcileFixedMessage(result, after, fixActions);
      result = after;
    }
  } catch (e) {
    // Если сама сверка не смогла выполниться (например, МойСклад не отвечает), владелец тоже узнаёт.
    text = `⚠️ <b>Сверка за ${date.split("-").reverse().join(".")} не выполнена</b>\nПричина: ${getErrorMessage(e)}`;
  }
  if (dry) return NextResponse.json({ date, dry, ok: result?.ok ?? false, checks: result?.checks ?? [], text });

  const { data: owner, error } = await supabaseAdmin
    .from("coach_users")
    .select("telegram_chat_id")
    .eq("is_protected", true)
    .eq("status", "approved")
    .maybeSingle();
  if (error || !owner) return NextResponse.json({ error: "Не найден главный владелец в боте." }, { status: 500 });
  try {
    await telegramTransport.send(owner.telegram_chat_id, text);
  } catch (e) {
    return NextResponse.json({ error: `Не удалось отправить: ${getErrorMessage(e)}`, text, fixActions }, { status: 500 });
  }
  return NextResponse.json({ date, ok: result?.ok ?? false, sent: true, fixActions, text });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
