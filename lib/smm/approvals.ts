// Подтверждение сотрудников бота СММ. Заявки приходят владельцу в личку бота-помощника (кнопки sm:<действие>:<id>), решает только он;
// человеку о решении сообщает бот СММ.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { ROLE_TITLE } from "@/lib/smm/config";
import { REMOVE_KEYBOARD, menuFor } from "@/lib/smm/menu";
import { telegramTransport, type ReplyMarkup } from "@/lib/smm/telegram";
import type { SmmStatus, SmmUser } from "@/lib/smm/users";

const STATUS_TEXT: Record<SmmStatus, string> = { pending: "🕒 ждёт подтверждения", approved: "✅ работает", rejected: "✖️ отклонён", disabled: "⏸ отключён", left: "🚪 убран" };

export const staffLine = (u: Pick<SmmUser, "name" | "username" | "role" | "status">) =>
  `<b>${escapeHtml(u.name)}</b>${u.username ? ` (@${escapeHtml(u.username)})` : ""}\nДолжность: ${ROLE_TITLE[u.role]} · ${STATUS_TEXT[u.status]}`;

export function staffKeyboard(u: Pick<SmmUser, "id" | "status">): ReplyMarkup | undefined {
  const b = (text: string, a: string) => ({ text, callback_data: `sm:${a}:${u.id}` });
  if (u.status === "pending") return { inline_keyboard: [[b("✅ Принять", "ok"), b("✖️ Отклонить", "no")]] };
  if (u.status === "approved") return { inline_keyboard: [[b("⏸ Отключить", "off"), b("🚪 Убрать", "del")]] };
  if (u.status === "disabled") return { inline_keyboard: [[b("▶️ Включить", "on"), b("🚪 Убрать", "del")]] };
  if (u.status === "rejected") return { inline_keyboard: [[b("✅ Принять", "ok")]] };
  return undefined;
}

// Новая заявка → владельцу в личку бота-помощника.
export async function notifyOwnerOfRequest(u: SmmUser): Promise<void> {
  await notifyOwner(`🔔 <b>Новая заявка в бот СММ</b>\n${staffLine(u)}`, staffKeyboard(u));
}

const DECISION: Record<string, { from: SmmStatus[]; to: SmmStatus; done: string; text: string }> = {
  ok: { from: ["pending", "rejected"], to: "approved", done: "принят", text: "🎉 Доступ подтверждён. Выберите раздел кнопкой внизу." },
  no: { from: ["pending"], to: "rejected", done: "заявка отклонена", text: "Заявку отклонили. Если это ошибка, обратитесь к руководителю." },
  off: { from: ["approved"], to: "disabled", done: "отключён", text: "Доступ к боту отключён. Обратитесь к руководителю." },
  on: { from: ["disabled"], to: "approved", done: "снова включён", text: "✅ Доступ к боту снова включён. Выберите раздел кнопкой внизу." },
  del: { from: ["pending", "approved", "disabled", "rejected"], to: "left", done: "убран", text: "Вас убрали из бота. Чтобы вернуться, нажмите /start." },
};

// Решение владельца кнопкой в боте-помощнике: меняет статус, пишет человеку из бота СММ и возвращает карточку с новыми кнопками.
export async function handleSmmOwnerCallback(data: string, ownerName: string): Promise<{ text: string; markup?: ReplyMarkup }> {
  const [, action, idRaw] = data.split(":");
  const id = Number(idRaw);
  const rule = DECISION[action];
  if (!rule || !Number.isInteger(id)) return { text: "Неверная кнопка." };
  const { data: row } = await supabaseAdmin.from("smm_users").select("*").eq("id", id).maybeSingle();
  const u = row as SmmUser | null;
  if (!u) return { text: "Сотрудник не найден." };
  if (!rule.from.includes(u.status)) return { text: `${staffLine(u)}\n\nУже сделано.`, markup: staffKeyboard(u) };
  const { error } = await supabaseAdmin.from("smm_users").update({ status: rule.to, decided_at: new Date().toISOString(), decided_by: ownerName, awaiting: null }).eq("id", id);
  if (error) return { text: `⚠️ Не получилось: ${escapeHtml(error.message)}` };
  let delivered = true;
  try {
    await telegramTransport.send(u.telegram_chat_id, rule.text, rule.to === "approved" ? menuFor(u.role) : REMOVE_KEYBOARD);
  } catch {
    delivered = false; // человек мог заблокировать бота
  }
  const next = { ...u, status: rule.to };
  return { text: `${staffLine(next)}\n\n${rule.done[0].toUpperCase()}${rule.done.slice(1)}.${delivered ? "" : " ⚠️ Человеку сообщение не дошло (возможно, заблокировал бота)."}`, markup: staffKeyboard(next) };
}
