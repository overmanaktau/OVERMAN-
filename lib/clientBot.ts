// Telegram-бот для клиентов (отдельный бот, токен TELEGRAM_CLIENTS_BOT_TOKEN). Сейчас только подписка и привязка номера.
import { createHash } from "node:crypto";

const API = "https://api.telegram.org";

function token(): string {
  const t = process.env.TELEGRAM_CLIENTS_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_CLIENTS_BOT_TOKEN не задан.");
  return t;
}

// Секрет, которым Telegram подписывает запросы вебхука (заголовок X-Telegram-Bot-Api-Secret-Token); выводится из токена.
export function webhookSecret(): string {
  return createHash("sha256").update(`clients:${token()}`).digest("hex").slice(0, 48);
}

export async function clientBotApi(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

export type ReplyMarkup = Record<string, unknown>;

// Куда уходят ответы бота: настоящий Telegram или перехват для проверки без токена (?mock=1).
export type ClientTransport = { send(chatId: number, html: string, markup?: ReplyMarkup): Promise<void> };

export const telegramClientTransport: ClientTransport = {
  async send(chatId, html, markup) {
    const r = await clientBotApi("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
    if (!r.ok) throw new Error(`Telegram: ${r.description ?? "не удалось отправить"}`);
  },
};
