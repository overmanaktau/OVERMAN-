// Telegram-бот помощника продавцов (отдельный бот, токен TELEGRAM_COACH_BOT_TOKEN).
import { createHash } from "node:crypto";

const API = "https://api.telegram.org";

function token(): string {
  const t = process.env.TELEGRAM_COACH_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_COACH_BOT_TOKEN не задан.");
  return t;
}

// Секрет, с которым Telegram подписывает запросы вебхука (заголовок
// X-Telegram-Bot-Api-Secret-Token). Выводится из токена бота, отдельной
// переменной не нужно.
export function webhookSecret(): string {
  return createHash("sha256").update(`coach:${token()}`).digest("hex").slice(0, 48);
}

export async function coachApi(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

export type ReplyMarkup = Record<string, unknown>;

// Куда уходят сообщения: настоящий Telegram или перехват для проверки без токена.
export type Transport = {
  send(chatId: number | string, html: string, markup?: ReplyMarkup): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  // Удалить сообщение (выбор сделан — кнопки больше не нужны). Ошибки не критичны.
  deleteMessage(chatId: number | string, messageId: number): Promise<void>;
};

export const telegramTransport: Transport = {
  async send(chatId, html, markup) {
    const r = await coachApi("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
    });
    if (!r.ok) throw new Error(`Telegram: ${r.description ?? "ошибка отправки"}`);
  },
  async answerCallback(callbackId, text) {
    await coachApi("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  },
  async deleteMessage(chatId, messageId) {
    await coachApi("deleteMessage", { chat_id: chatId, message_id: messageId });
  },
};

// Постоянная клавиатура с разделами для подтверждённых продавцов.
export const MENU_MARKUP: ReplyMarkup = {
  keyboard: [
    [{ text: "Мой план" }, { text: "Что повысить" }],
    [{ text: "План на неделю" }, { text: "Итоги прошлой недели" }],
    [{ text: "Помощь" }, { text: "Выход" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const REMOVE_KEYBOARD: ReplyMarkup = { remove_keyboard: true };
