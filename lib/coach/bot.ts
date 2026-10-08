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
  // Убрать кнопки под сообщением, оставив само сообщение в истории чата.
  clearButtons(chatId: number | string, messageId: number): Promise<void>;
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
  async clearButtons(chatId, messageId) {
    await coachApi("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  },
};

// Постоянная клавиатура с разделами для подтверждённых продавцов.
// У стилиста-консультанта кнопок просмотра плана и продаж нет: бот сам присылает сообщения
// (утром после смены и по понедельникам). Остались только «Помощь» и «Выход».
export const MENU_MARKUP: ReplyMarkup = {
  keyboard: [[{ text: "Помощь" }, { text: "Выход" }]],
  resize_keyboard: true,
  is_persistent: true,
};

// Стилист-консультант: «Сертификат» (продать / использовать / вернуть) плюс «Помощь» и «Выход».
export const CONSULTANT_MENU_MARKUP: ReplyMarkup = {
  keyboard: [[{ text: "Сертификат" }], [{ text: "Помощь" }, { text: "Выход" }]],
  resize_keyboard: true,
  is_persistent: true,
};

// У администратора бота только разделы управления сотрудниками: личных продаж
// и плана у него нет, поэтому «Мой план» и остальных консультантских разделов нет.
// «Выхода» тоже нет — администратор не может отвязать себя.
// Остальные владельцы: сотрудников и продажи всех городов смотрят, но заявки,
// отключение и роли — только у главного владельца, поэтому «Заявок» у них нет.
export const ADMIN_MENU_MARKUP: ReplyMarkup = {
  keyboard: [[{ text: "Сотрудники" }, { text: "Продажи" }], [{ text: "Сертификаты" }], [{ text: "Помощь" }, { text: "Выход" }]],
  resize_keyboard: true,
  is_persistent: true,
};

// Главный владелец: всё управление; выйти не может — меню без «Выхода».
export const MAIN_OWNER_MENU_MARKUP: ReplyMarkup = {
  keyboard: [[{ text: "Заявки" }, { text: "Сотрудники" }], [{ text: "Продажи" }, { text: "Сертификаты" }], [{ text: "Помощь" }]],
  resize_keyboard: true,
  is_persistent: true,
};

// Тестовый аккаунт в роли руководителя: только разделы управления (с условными данными).
export const MANAGER_DEMO_MENU_MARKUP: ReplyMarkup = {
  keyboard: [[{ text: "Заявки" }, { text: "Сотрудники" }], [{ text: "Продажи" }], [{ text: "Помощь" }, { text: "Выход" }]],
  resize_keyboard: true,
  is_persistent: true,
};

// Администратор города: только продажи своего города. Заявки и сотрудники — только у владельца.
export const CITY_ADMIN_MENU_MARKUP: ReplyMarkup = {
  keyboard: [[{ text: "Продажи" }, { text: "Сертификаты" }], [{ text: "Помощь" }, { text: "Выход" }]],
  resize_keyboard: true,
  is_persistent: true,
};

export type MenuUser = {
  is_admin?: boolean | null;
  admin_scope?: string | null;
  is_protected?: boolean | null;
  is_test?: boolean | null;
  test_role?: string | null;
};

// Владелец — администратор с доступом ко всем городам.
export function isOwner(u: { is_admin?: boolean | null; admin_scope?: string | null }): boolean {
  return !!u.is_admin && u.admin_scope === "all";
}

// Роль для текстов бота: владелец или администратор (города), у остальных — пусто.
export function roleLabel(u: { is_admin?: boolean | null; admin_scope?: string | null }): string {
  if (!u.is_admin) return "";
  return isOwner(u) ? "владелец" : "администратор";
}

export function menuFor(u: MenuUser): ReplyMarkup {
  if (u.is_test) return u.test_role === "manager" ? MANAGER_DEMO_MENU_MARKUP : MENU_MARKUP;
  if (!u.is_admin) return CONSULTANT_MENU_MARKUP;
  if (!isOwner(u)) return CITY_ADMIN_MENU_MARKUP;
  return u.is_protected ? MAIN_OWNER_MENU_MARKUP : ADMIN_MENU_MARKUP;
}

export const REMOVE_KEYBOARD: ReplyMarkup = { remove_keyboard: true };

// Прощальный текст: сотрудник вышел сам или его убрал руководитель.
export const LEAVE_TEXT =
  "Вы успешно вышли из сервиса «Помощник консультанта». Спасибо за работу и желаем вам удачи! Если захотите вернуться, нажмите /start.";
