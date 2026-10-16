import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { smmApi, webhookSecret } from "@/lib/smm/telegram";

// Разовая настройка бота для СММ: привязывает вебхук к этому сайту и ставит команды. Запускается один раз после того,
// как в Vercel добавлен TELEGRAM_SMM_BOT_TOKEN (и повторно, если токен или адрес сайта поменялись).
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  try {
    const hook = await smmApi("setWebhook", {
      url: "https://www.overman.kz/api/telegram/smm",
      secret_token: webhookSecret(),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    const commands = await smmApi("setMyCommands", {
      commands: [
        { command: "start", description: "Войти / заявка на доступ" },
        { command: "menu", description: "Показать меню" },
        { command: "cancel", description: "Отменить ввод" },
      ],
    });
    const info = await smmApi("getWebhookInfo", {});
    const me = await smmApi("getMe", {});
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
