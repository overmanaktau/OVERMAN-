// Решения по сотрудникам бота-помощника: подтвердить, отклонить, отключить,
// включить, убрать. Общая логика для страницы портала (API) и для администратора
// прямо в Telegram — человеку сразу уходит сообщение о решении.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { getErrorMessage } from "@/lib/errors";
import { LEAVE_TEXT, REMOVE_KEYBOARD, menuFor, type ReplyMarkup, type Transport } from "@/lib/coach/bot";

export type CoachAction = "approve" | "reject" | "disable" | "enable" | "remove";

export const COACH_ACTIONS: CoachAction[] = ["approve", "reject", "disable", "enable", "remove"];

const NEXT_STATUS: Record<CoachAction, { from: string[]; to: string }> = {
  approve: { from: ["pending"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  disable: { from: ["approved"], to: "disabled" },
  enable: { from: ["disabled", "rejected"], to: "approved" },
  remove: { from: ["pending", "approved", "disabled", "rejected"], to: "left" },
};

type NoticeUser = { employee_name: string; rejoined: boolean; is_admin: boolean };

function notice(action: CoachAction, u: NoticeUser): { text: string; markup: ReplyMarkup } {
  const name = escapeHtml(u.employee_name);
  switch (action) {
    case "approve":
      // Первый вход — «Добро пожаловать», вернувшемуся после выхода — «С возвращением».
      return {
        text: u.rejoined
          ? `🎉 С возвращением в систему, ${name}! Руководитель подтвердил ваш доступ. Выберите раздел кнопкой внизу.`
          : `🎉 Добро пожаловать, ${name}! Руководитель подтвердил ваш доступ. Выберите раздел кнопкой внизу.`,
        markup: menuFor(u.is_admin),
      };
    case "enable":
      return { text: "✅ Доступ к боту снова включён. Выберите раздел кнопкой внизу.", markup: menuFor(u.is_admin) };
    case "reject":
      return {
        text: "Заявку отклонили. Если это ошибка, нажмите /start и отправьте её заново или обратитесь к руководителю.",
        markup: REMOVE_KEYBOARD,
      };
    case "disable":
      return { text: "Доступ к боту отключён. Обратитесь к руководителю.", markup: REMOVE_KEYBOARD };
    case "remove":
      return { text: LEAVE_TEXT, markup: REMOVE_KEYBOARD };
  }
}

export type DecisionResult =
  | { ok: true; status: string; notified: boolean; employeeName: string }
  | { ok: false; code: number; error: string };

export async function decideCoachUser(userId: number, action: CoachAction, decidedBy: string, t: Transport): Promise<DecisionResult> {
  const { data: user, error: fetchError } = await supabaseAdmin.from("coach_users").select("*").eq("id", userId).maybeSingle();
  if (fetchError) return { ok: false, code: 400, error: fetchError.message };
  if (!user) return { ok: false, code: 404, error: "Заявка не найдена." };

  const rule = NEXT_STATUS[action];
  if (!rule.from.includes(user.status)) return { ok: false, code: 409, error: "Статус уже изменился — обновите список." };
  if (user.is_admin && (action === "disable" || action === "remove" || action === "reject")) {
    return { ok: false, code: 403, error: "Администратора бота нельзя отключить или убрать." };
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("coach_users")
    .update({ status: rule.to, decided_at: now, decided_by: decidedBy, ...(action === "remove" ? { left_at: now } : {}) })
    .eq("id", user.id);
  if (updateError) {
    const taken = /coach_users_employee_active|duplicate/i.test(updateError.message);
    return {
      ok: false,
      code: taken ? 409 : 400,
      error: taken ? "Этот сотрудник уже привязан к другому Telegram-аккаунту." : updateError.message,
    };
  }

  let notified = true;
  try {
    const n = notice(action, user as NoticeUser);
    await t.send(user.telegram_chat_id, n.text, n.markup);
  } catch (e) {
    notified = false;
    console.error("coach notice error:", getErrorMessage(e));
  }
  return { ok: true, status: rule.to, notified, employeeName: user.employee_name as string };
}
