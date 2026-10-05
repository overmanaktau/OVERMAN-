// Решения по сотрудникам бота-помощника: подтвердить, отклонить, отключить,
// включить, убрать. Общая логика для страницы портала (API) и для администратора
// прямо в Telegram — человеку сразу уходит сообщение о решении.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { getErrorMessage } from "@/lib/errors";
import { LEAVE_TEXT, REMOVE_KEYBOARD, menuFor, type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { TEST_WARNING, demoAutoMessages, testExpiresAt } from "@/lib/coach/testmode";
import { todayInAlmaty } from "@/lib/coach/metrics";

export type CoachAction = "approve" | "reject" | "disable" | "enable" | "remove";

export const COACH_ACTIONS: CoachAction[] = ["approve", "reject", "disable", "enable", "remove"];

const NEXT_STATUS: Record<CoachAction, { from: string[]; to: string }> = {
  approve: { from: ["pending"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  disable: { from: ["approved"], to: "disabled" },
  enable: { from: ["disabled", "rejected"], to: "approved" },
  remove: { from: ["pending", "approved", "disabled", "rejected"], to: "left" },
};

type NoticeUser = { employee_name: string; rejoined: boolean; is_admin: boolean; admin_scope: string; is_protected: boolean; is_test: boolean; test_role: string | null };

function notice(action: CoachAction, u: NoticeUser): { text: string; markup: ReplyMarkup } {
  const name = escapeHtml(u.employee_name);
  if (u.is_test && (action === "approve" || action === "enable")) {
    return {
      text: `✅ Тестовый аккаунт подтверждён. Выберите раздел кнопкой внизу.\n\n${TEST_WARNING}`,
      markup: menuFor(u),
    };
  }
  switch (action) {
    case "approve":
      // Первый вход — «Добро пожаловать», вернувшемуся после выхода — «С возвращением».
      return {
        text: u.rejoined
          ? `🎉 С возвращением в систему, ${name}! Руководитель подтвердил ваш доступ. Выберите раздел кнопкой внизу.`
          : `🎉 Добро пожаловать, ${name}! Руководитель подтвердил ваш доступ. Выберите раздел кнопкой внизу.`,
        markup: menuFor(u),
      };
    case "enable":
      return { text: "✅ Доступ к боту снова включён. Выберите раздел кнопкой внизу.", markup: menuFor(u) };
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

// ---- Роли ----
// consultant — обычный стилист-консультант; city_admin — продажи своего города;
// owner — всё: заявки, сотрудники, продажи по всем городам (владельцев может быть несколько).
export type CoachRole = "consultant" | "city_admin" | "owner";
export const COACH_ROLES: CoachRole[] = ["consultant", "city_admin", "owner"];

export const ROLE_TITLE: Record<CoachRole, string> = {
  consultant: "Стилист-консультант",
  city_admin: "Администратор",
  owner: "Владелец",
};

export function roleOf(u: { is_admin: boolean; admin_scope: string }): CoachRole {
  if (!u.is_admin) return "consultant";
  return u.admin_scope === "all" ? "owner" : "city_admin";
}

const CITY_NAME: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };

export type RoleResult = { ok: true; employeeName: string; role: CoachRole; notified: boolean } | { ok: false; code: number; error: string };

// Меняет роль подтверждённого сотрудника. actorUserId — запись того, кто меняет
// (из бота), чтобы нельзя было изменить собственную роль; из портала — null.
export async function changeCoachRole(userId: number, role: CoachRole, actorUserId: number | null, t: Transport): Promise<RoleResult> {
  if (!COACH_ROLES.includes(role)) return { ok: false, code: 400, error: "Неизвестная роль." };
  const { data: user, error } = await supabaseAdmin.from("coach_users").select("*").eq("id", userId).maybeSingle();
  if (error) return { ok: false, code: 400, error: error.message };
  if (!user) return { ok: false, code: 404, error: "Сотрудник не найден." };
  if (user.is_test) return { ok: false, code: 400, error: "У тестового аккаунта роль не меняется." };
  if (user.status !== "approved") return { ok: false, code: 409, error: "Роль можно менять только у подтверждённого сотрудника." };
  if (user.is_protected) return { ok: false, code: 403, error: "Роль главного владельца изменить нельзя." };
  if (actorUserId !== null && actorUserId === user.id) return { ok: false, code: 403, error: "Свою роль изменить нельзя." };
  const current = roleOf(user);
  if (current === role) return { ok: false, code: 409, error: "У сотрудника уже эта роль." };

  // Хотя бы один владелец должен остаться.
  if (current === "owner") {
    const { count, error: countError } = await supabaseAdmin
      .from("coach_users")
      .select("id", { count: "exact", head: true })
      .eq("is_admin", true)
      .eq("admin_scope", "all")
      .eq("status", "approved")
      .eq("is_test", false)
      .neq("id", user.id);
    if (countError) return { ok: false, code: 400, error: countError.message };
    if ((count ?? 0) === 0) return { ok: false, code: 409, error: "Нельзя оставить бота без владельца: сначала назначьте другого." };
  }

  const patch = { is_admin: role !== "consultant", admin_scope: role === "owner" ? "all" : "city", awaiting: null };
  const { error: updateError } = await supabaseAdmin.from("coach_users").update(patch).eq("id", user.id);
  if (updateError) return { ok: false, code: 400, error: updateError.message };

  let notified = true;
  try {
    const updated = { ...user, ...patch };
    const text =
      role === "owner"
        ? "Ваша роль изменена: <b>владелец</b>. Вам доступны заявки, сотрудники и продажи по всем городам."
        : role === "city_admin"
          ? `Ваша роль изменена: <b>администратор</b>. Вам доступны продажи вашего города (${CITY_NAME[user.store] ?? ""}).`
          : "Ваша роль изменена: <b>стилист-консультант</b>. Выберите раздел кнопкой внизу.";
    await t.send(user.telegram_chat_id, text, menuFor(updated));
  } catch (e) {
    notified = false;
    console.error("coach role notice error:", getErrorMessage(e));
  }
  return { ok: true, employeeName: user.employee_name as string, role, notified };
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
  // Главного владельца нельзя ни отключить, ни убрать; остальных владельцев и администраторов можно.
  if (user.is_protected && (action === "disable" || action === "remove" || action === "reject")) {
    return { ok: false, code: 403, error: "Этого владельца нельзя отключить или убрать." };
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("coach_users")
    .update({
      status: rule.to,
      decided_at: now,
      decided_by: decidedBy,
      // Убранный человек теряет и роль: вернётся — снова обычным сотрудником.
      ...(action === "remove" ? { left_at: now, is_admin: false, admin_scope: "city", awaiting: null } : {}),
      // Тестовому аккаунту при подтверждении (и включении) даётся 30 минут.
      ...(user.is_test && (action === "approve" || action === "enable") ? { test_expires_at: testExpiresAt() } : {}),
    })
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
    // Тестовому консультанту сразу показываем образцы сообщений, которые настоящий стилист получает сам.
    if (user.is_test && user.test_role === "consultant" && (action === "approve" || action === "enable")) {
      for (const sample of demoAutoMessages(todayInAlmaty())) await t.send(user.telegram_chat_id, sample);
    }
  } catch (e) {
    notified = false;
    console.error("coach notice error:", getErrorMessage(e));
  }
  return { ok: true, status: rule.to, notified, employeeName: user.employee_name as string };
}
