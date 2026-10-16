// Telegram для бота СММ (отдельный бот, токен TELEGRAM_SMM_BOT_TOKEN).
import { createHash } from "node:crypto";

const API = "https://api.telegram.org";

function token(): string {
  const t = process.env.TELEGRAM_SMM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_SMM_BOT_TOKEN не задан.");
  return t;
}

// Секрет, которым Telegram подписывает запросы вебхука; выводится из токена.
export function webhookSecret(): string {
  return createHash("sha256").update(`smm:${token()}`).digest("hex").slice(0, 48);
}

export async function smmApi(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`${API}/bot${token()}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

export type ReplyMarkup = Record<string, unknown>;

// Куда уходят ответы бота: настоящий Telegram или перехват для проверки (?mock=1).
export type Transport = {
  send(chatId: number, html: string, markup?: ReplyMarkup): Promise<number | null>;
  photo(chatId: number, url: string, caption: string, markup?: ReplyMarkup): Promise<number | null>;
  edit(chatId: number, messageId: number, html: string, markup?: ReplyMarkup): Promise<void>;
  answer(callbackId: string, text?: string): Promise<void>;
};

export const telegramTransport: Transport = {
  async send(chatId, html, markup) {
    const r = await smmApi("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
    if (!r.ok) throw new Error(`Telegram: ${r.description ?? "не удалось отправить"}`);
    return (r.result as { message_id?: number } | undefined)?.message_id ?? null;
  },
  async photo(chatId, url, caption, markup) {
    const r = await smmApi("sendPhoto", { chat_id: chatId, photo: url, caption, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) });
    if (!r.ok) {
      // картинка не загрузилась (например, ссылка устарела) — отправляем хотя бы текст
      return telegramTransport.send(chatId, caption, markup);
    }
    return (r.result as { message_id?: number } | undefined)?.message_id ?? null;
  },
  async edit(chatId, messageId, html, markup) {
    await smmApi("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  },
  async answer(callbackId, text) {
    await smmApi("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  },
};

// Длинный текст режем по строкам на сообщения до лимита Telegram.
export function splitText(text: string, max = 3800): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > max && cur) {
      out.push(cur);
      cur = line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
