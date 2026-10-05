import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { coachApi, webhookSecret } from "@/lib/coach/bot";

// Разовая настройка бота-помощника: привязывает вебхук к этому сайту и ставит
// список команд. Запускается один раз после того, как в Vercel добавлен
// TELEGRAM_COACH_BOT_TOKEN (и повторно, если токен или адрес сайта поменялись).
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  try {
    const hook = await coachApi("setWebhook", {
      url: "https://www.overman.kz/api/telegram/coach",
      secret_token: webhookSecret(),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    const commands = await coachApi("setMyCommands", {
      commands: [
        { command: "start", description: "Начать / главное меню" },
        { command: "help", description: "Помощь" },
      ],
    });
    const info = await coachApi("getWebhookInfo", {});
    const me = await coachApi("getMe", {});
    return NextResponse.json({ ok: hook.ok && commands.ok, setWebhook: hook, setMyCommands: commands, webhook: info.result, bot: me.result });
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
