// Управление сотрудниками прямо в боте — только для администратора бота
// (coach_users.is_admin): список заявок и сотрудников, карточка сотрудника,
// принять / отклонить / отключить / включить / убрать. Решения проходят через
// ту же логику, что и страница портала (lib/coach/decisions).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { getErrorMessage } from "@/lib/errors";
import { type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { COACH_ACTIONS, decideCoachUser, type CoachAction } from "@/lib/coach/decisions";

type Row = {
  id: number;
  employee_name: string;
  store: string;
  status: "pending" | "approved" | "rejected" | "disabled" | "left";
  telegram_name: string | null;
  telegram_username: string | null;
  is_admin: boolean;
};

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const STATUS_ICON: Record<Row["status"], string> = { pending: "🕒", approved: "✅", rejected: "✖️", disabled: "⏸", left: "🚪" };
const STATUS_TEXT: Record<Row["status"], string> = {
  pending: "ожидает подтверждения",
  approved: "подтверждён",
  rejected: "отклонён",
  disabled: "отключён",
  left: "вышел из системы",
};
const ACTION_RESULT: Record<CoachAction, string> = {
  approve: "подтверждён",
  reject: "заявка отклонена",
  disable: "отключён",
  enable: "снова включён",
  remove: "убран из системы",
};
const ACTION_ASK: Partial<Record<CoachAction, string>> = {
  disable: "Отключить",
  remove: "Убрать из системы",
};

const ORDER: Record<Row["status"], number> = { pending: 0, approved: 1, disabled: 2, rejected: 3, left: 4 };

async function loadRows(): Promise<Row[]> {
  const { data, error } = await supabaseAdmin
    .from("coach_users")
    .select("id, employee_name, store, status, telegram_name, telegram_username, is_admin");
  if (error) throw error;
  return ((data ?? []) as Row[]).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.employee_name.localeCompare(b.employee_name, "ru"));
}

function tgLabel(r: Row): string {
  return `${r.telegram_name ?? "—"}${r.telegram_username ? ` (@${r.telegram_username})` : ""}`;
}

// Раздел «Заявки» (только ожидающие) или «Сотрудники» (все, кроме вышедших).
export async function sendStaffList(t: Transport, chatId: number | string, kind: "pending" | "all") {
  const all = await loadRows();
  const rows = kind === "pending" ? all.filter((r) => r.status === "pending") : all.filter((r) => r.status !== "left");
  if (rows.length === 0) {
    await t.send(chatId, kind === "pending" ? "Новых заявок нет." : "Сотрудников пока нет.");
    return;
  }
  const title = kind === "pending" ? `🕒 <b>Заявки на подтверждение · ${rows.length}</b>` : `👥 <b>Сотрудники · ${rows.length}</b>`;
  const legend = kind === "all" ? "\n🕒 ждёт · ✅ подтверждён · ⏸ отключён · ✖️ отклонён" : "";
  await t.send(chatId, `${title}${legend}\nНажмите на имя, чтобы открыть карточку.`, {
    inline_keyboard: rows.map((r) => [
      { text: `${STATUS_ICON[r.status]} ${r.employee_name} · ${CITY[r.store] ?? r.store}`, callback_data: `adm:u:${r.id}` },
    ]),
  });
}

function actionsFor(r: Row): CoachAction[] {
  if (r.is_admin) return [];
  switch (r.status) {
    case "pending":
      return ["approve", "reject"];
    case "approved":
      return ["disable", "remove"];
    case "disabled":
    case "rejected":
      return ["enable", "remove"];
    default:
      return [];
  }
}

const ACTION_BUTTON: Record<CoachAction, string> = {
  approve: "✅ Принять",
  reject: "❌ Отказать",
  disable: "⏸ Отключить",
  enable: "▶️ Включить",
  remove: "🗑 Убрать",
};

async function sendCard(t: Transport, chatId: number | string, id: number) {
  const rows = await loadRows();
  const r = rows.find((x) => x.id === id);
  if (!r) {
    await t.send(chatId, "Сотрудник не найден.", { inline_keyboard: [[{ text: "← К списку", callback_data: "adm:list" }]] });
    return;
  }
  const buttons = actionsFor(r).map((a) => ({
    text: ACTION_BUTTON[a],
    // Необратимое подтверждаем отдельным шагом, остальное — сразу.
    callback_data: ACTION_ASK[a] ? `adm:ask:${a}:${r.id}` : `adm:do:${a}:${r.id}`,
  }));
  const markup: ReplyMarkup = {
    inline_keyboard: [...(buttons.length ? [buttons] : []), [{ text: "← К списку", callback_data: "adm:list" }]],
  };
  await t.send(
    chatId,
    `<b>${escapeHtml(r.employee_name)}</b> · ${CITY[r.store] ?? r.store}${r.is_admin ? " · администратор" : ""}\nСтатус: ${STATUS_ICON[r.status]} ${STATUS_TEXT[r.status]}\nTelegram: ${escapeHtml(tgLabel(r))}`,
    markup
  );
}

// Разбор нажатий adm:*. Вызывать только для подтверждённого администратора.
export async function handleAdminCallback(
  data: string,
  t: Transport,
  chatId: number | string,
  adminName: string,
  dropCurrent: () => Promise<void>
): Promise<void> {
  const parts = data.split(":"); // adm:list | adm:u:<id> | adm:ask:<action>:<id> | adm:do:<action>:<id>
  await dropCurrent();
  const kind = parts[1];
  if (kind === "list") {
    await sendStaffList(t, chatId, "all");
    return;
  }
  if (kind === "u") {
    await sendCard(t, chatId, Number(parts[2]));
    return;
  }
  const action = parts[2] as CoachAction;
  const id = Number(parts[3]);
  if (!COACH_ACTIONS.includes(action) || !Number.isFinite(id)) return;

  if (kind === "ask") {
    const rows = await loadRows();
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    await t.send(chatId, `${ACTION_ASK[action] ?? ACTION_BUTTON[action]}: <b>${escapeHtml(r.employee_name)}</b>?`, {
      inline_keyboard: [[{ text: "Да", callback_data: `adm:do:${action}:${id}` }, { text: "Нет", callback_data: `adm:u:${id}` }]],
    });
    return;
  }

  if (kind === "do") {
    let text: string;
    try {
      const result = await decideCoachUser(id, action, `бот: ${adminName}`, t);
      text = result.ok
        ? `Готово: <b>${escapeHtml(result.employeeName)}</b> — ${ACTION_RESULT[action]}.${result.notified ? "" : "\nСообщение сотруднику доставить не удалось."}`
        : `Не получилось: ${escapeHtml(result.error)}`;
    } catch (e) {
      text = `Не получилось: ${escapeHtml(getErrorMessage(e))}`;
    }
    await t.send(chatId, text, { inline_keyboard: [[{ text: "← К списку сотрудников", callback_data: "adm:list" }]] });
  }
}

// Новая заявка — сразу всем администраторам, с кнопками «Принять» / «Отказать».
export async function notifyAdminsOfRequest(t: Transport, telegramUserId: number): Promise<void> {
  try {
    const [{ data: req }, { data: admins }] = await Promise.all([
      supabaseAdmin
        .from("coach_users")
        .select("id, employee_name, store, telegram_name, telegram_username, rejoined")
        .eq("telegram_user_id", telegramUserId)
        .maybeSingle(),
      supabaseAdmin.from("coach_users").select("telegram_chat_id").eq("is_admin", true).eq("status", "approved"),
    ]);
    if (!req) return;
    const r = req as Row & { rejoined: boolean };
    const text = `🆕 <b>Новая заявка${r.rejoined ? " (возвращается)" : ""}</b>\n${escapeHtml(r.employee_name)} · ${CITY[r.store] ?? r.store}\nTelegram: ${escapeHtml(tgLabel(r))}\nПроверьте, что это именно этот сотрудник.`;
    const markup: ReplyMarkup = {
      inline_keyboard: [[
        { text: "✅ Принять", callback_data: `adm:do:approve:${r.id}` },
        { text: "❌ Отказать", callback_data: `adm:do:reject:${r.id}` },
      ]],
    };
    for (const a of (admins ?? []) as { telegram_chat_id: number }[]) {
      try {
        await t.send(a.telegram_chat_id, text, markup);
      } catch (e) {
        console.error("coach admin notify error:", getErrorMessage(e));
      }
    }
  } catch (e) {
    console.error("coach admin notify error:", getErrorMessage(e));
  }
}
