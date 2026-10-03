// Управление сотрудниками прямо в боте — только для администратора бота
// (coach_users.is_admin): список заявок и сотрудников, карточка сотрудника,
// принять / отклонить / отключить / включить / убрать. Решения проходят через
// ту же логику, что и страница портала (lib/coach/decisions).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { getErrorMessage } from "@/lib/errors";
import { type ReplyMarkup, type Transport, roleLabel } from "@/lib/coach/bot";
import {
  COACH_ACTIONS,
  COACH_ROLES,
  ROLE_TITLE,
  changeCoachRole,
  decideCoachUser,
  roleOf,
  type CoachAction,
  type CoachRole,
} from "@/lib/coach/decisions";
import { monthStatus, todayInAlmaty } from "@/lib/coach/metrics";
import { handleSalesCallback } from "@/lib/coach/salesview";
import { money } from "@/lib/reports/sales";

type Row = {
  id: number;
  employee_ms_id: string;
  admin_scope: string;
  is_protected: boolean;
  is_test: boolean;
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
    .select("id, employee_ms_id, admin_scope, is_protected, is_test, employee_name, store, status, telegram_name, telegram_username, is_admin");
  if (error) throw error;
  return ((data ?? []) as Row[]).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.employee_name.localeCompare(b.employee_name, "ru"));
}

function tgLabel(r: Row): string {
  return `${r.telegram_name ?? "—"}${r.telegram_username ? ` (@${r.telegram_username})` : ""}`;
}

// Раздел «Заявки» (только ожидающие) или «Сотрудники» (все, кроме вышедших).
export async function sendStaffList(t: Transport, chatId: number | string, kind: "pending" | "all", stores: string[]) {
  const all = (await loadRows()).filter((r) => stores.includes(r.store));
  const rows = kind === "pending" ? all.filter((r) => r.status === "pending") : all.filter((r) => r.status !== "left");
  if (rows.length === 0) {
    await t.send(chatId, kind === "pending" ? "Новых заявок нет." : "Сотрудников пока нет.");
    return;
  }
  const title = kind === "pending" ? `🕒 <b>Заявки на подтверждение · ${rows.length}</b>` : `👥 <b>Сотрудники · ${rows.length}</b>`;
  const legend = kind === "all" ? "\n🕒 ждёт · ✅ подтверждён · ⏸ отключён · ✖️ отклонён" : "";
  await t.send(chatId, `${title}${legend}\nНажмите на имя, чтобы открыть карточку.`, {
    inline_keyboard: rows.map((r) => [
      {
        text: `${STATUS_ICON[r.status]} ${r.employee_name} · ${CITY[r.store] ?? r.store}${r.is_admin ? (r.admin_scope === "all" ? " · 👑" : " · 🛡") : ""}`,
        callback_data: `adm:u:${r.id}`,
      },
    ]),
  });
}

function actionsFor(r: Row): CoachAction[] {
  if (r.is_protected) return []; // главного владельца нельзя ни отключить, ни убрать
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

async function sendCard(t: Transport, chatId: number | string, id: number, stores: string[], canManage: boolean) {
  const rows = await loadRows();
  const r = rows.find((x) => x.id === id && stores.includes(x.store));
  if (!r) {
    await t.send(chatId, "Сотрудник не найден.", { inline_keyboard: [[{ text: "← К списку", callback_data: "adm:list" }]] });
    return;
  }
  // Принимать, отключать и менять роли может только главный владелец; остальным карточка только для просмотра.
  const buttons = (canManage ? actionsFor(r) : []).map((a) => ({
    text: ACTION_BUTTON[a],
    // Необратимое подтверждаем отдельным шагом, остальное — сразу.
    callback_data: ACTION_ASK[a] ? `adm:ask:${a}:${r.id}` : `adm:do:${a}:${r.id}`,
  }));
  const markup: ReplyMarkup = {
    inline_keyboard: [
      ...(buttons.length ? [buttons] : []),
      ...(canManage && r.status === "approved" && !r.is_test && !r.is_protected ? [[{ text: "👤 Роль", callback_data: `adm:r:${r.id}` }]] : []),
      ...(r.is_test ? [] : [[{ text: `📊 Продажи · ${CITY[r.store] ?? r.store}`, callback_data: `adm:s:c:e:${r.store}` }]]),
      [{ text: "← К списку", callback_data: "adm:list" }],
    ],
  };
  // Для настоящего подтверждённого сотрудника — как идёт месяц (план/факт).
  let month = "";
  if (!r.is_test && !r.is_admin && (r.status === "approved" || r.status === "disabled")) {
    try {
      const s = await monthStatus({ id: r.employee_ms_id, name: r.employee_name, store: r.store }, todayInAlmaty());
      month =
        s.plan === null
          ? `\nМесяц: факт ${money(s.fact)}, план не внесён`
          : `\nМесяц: факт ${money(s.fact)} из плана ${money(s.plan)}${s.pct !== null ? ` (${s.pct.toFixed(1)}%)` : ""}`;
    } catch (e) {
      console.error("coach card stats error:", getErrorMessage(e));
    }
  }
  await t.send(
    chatId,
    `<b>${escapeHtml(r.employee_name)}</b> · ${CITY[r.store] ?? r.store}${r.is_admin ? ` · ${roleLabel(r)}` : ""}\nСтатус: ${STATUS_ICON[r.status]} ${STATUS_TEXT[r.status]}\nTelegram: ${escapeHtml(tgLabel(r))}${month}`,
    markup
  );
}

// Разбор нажатий adm:*. Вызывать только для подтверждённого администратора.
export async function handleAdminCallback(
  data: string,
  t: Transport,
  chatId: number | string,
  adminName: string,
  dropCurrent: () => Promise<void>,
  clearCurrent: () => Promise<void>,
  stores: string[], // города, которые видит этот администратор
  owner: boolean, // владелец (все города): видит список сотрудников и карточки
  userId: number, // запись администратора (для ожидания ввода своего периода)
  canManage: boolean // главный владелец: принимает, отключает, меняет роли
): Promise<void> {
  // adm:list | adm:u:<id> | adm:ask:<action>:<id> | adm:do:<action>:<id> | adm:req:<action>:<id> | adm:s…
  const parts = data.split(":");
  const kind = parts[1];
  // Администратор города — только «Продажи» (adm:s…); список и карточки — владельцам;
  // любые решения (принять, отключить, роли) — только главному владельцу.
  if (kind === "s") {
    // доступно всем администраторам
  } else if (kind === "list" || kind === "u") {
    if (!owner) return;
  } else if (!canManage) {
    return;
  }
  // Экраны выбора (списки, карточки, подтверждение) после нажатия исчезают.
  // Сообщение «Новая заявка» (req) остаётся в истории чата — у него только убираются
  // кнопки, как и итоговое «Готово: …».
  if (kind === "req") await clearCurrent();
  else await dropCurrent();
  if (kind === "s") {
    await handleSalesCallback(parts, t, chatId, stores, userId);
    return;
  }
  if (kind === "list") {
    await sendStaffList(t, chatId, "all", stores);
    return;
  }
  if (kind === "u") {
    await sendCard(t, chatId, Number(parts[2]), stores, canManage);
    return;
  }
  // Роли: adm:r:<id> (выбор) | adm:rq:<роль>:<id> (подтвердить владельца) | adm:rs:<роль>:<id> (применить)
  if (kind === "r" || kind === "rq" || kind === "rs") {
    const roleId = Number(kind === "r" ? parts[2] : parts[3]);
    const target = (await loadRows()).find((x) => x.id === roleId);
    if (!target || !stores.includes(target.store)) return;
    const current = roleOf(target);
    if (kind === "r") {
      await t.send(chatId, `<b>${escapeHtml(target.employee_name)}</b>\nТекущая роль: <b>${ROLE_TITLE[current]}</b>\nВыберите новую роль:`, {
        inline_keyboard: [
          ...COACH_ROLES.map((role) => [
            {
              text: `${role === current ? "✓ " : ""}${ROLE_TITLE[role]}`,
              callback_data: role === current ? `adm:u:${roleId}` : role === "owner" ? `adm:rq:owner:${roleId}` : `adm:rs:${role}:${roleId}`,
            },
          ]),
          [{ text: "← К карточке", callback_data: `adm:u:${roleId}` }],
        ],
      });
      return;
    }
    const role = parts[2] as CoachRole;
    if (kind === "rq") {
      await t.send(chatId, `Сделать <b>${escapeHtml(target.employee_name)}</b> владельцем? Владельцу доступны заявки, сотрудники и продажи по всем городам.`, {
        inline_keyboard: [[{ text: "Да", callback_data: `adm:rs:owner:${roleId}` }, { text: "Нет", callback_data: `adm:r:${roleId}` }]],
      });
      return;
    }
    let text: string;
    try {
      const result = await changeCoachRole(roleId, role, userId, t);
      text = result.ok
        ? `Готово: <b>${escapeHtml(result.employeeName)}</b> — теперь ${ROLE_TITLE[result.role].toLowerCase()}.${result.notified ? "" : "\nСообщение сотруднику доставить не удалось."}`
        : `Не получилось: ${escapeHtml(result.error)}`;
    } catch (e) {
      text = `Не получилось: ${escapeHtml(getErrorMessage(e))}`;
    }
    await t.send(chatId, text); // без кнопок — остаётся в истории чата
    return;
  }

  const action = parts[2] as CoachAction;
  const id = Number(parts[3]);
  if (!COACH_ACTIONS.includes(action) || !Number.isFinite(id)) return;

  // Решения — только по сотрудникам своих городов.
  const target = (await loadRows()).find((x) => x.id === id);
  if (!target || !stores.includes(target.store)) return;

  if (kind === "ask") {
    const r = target;
    await t.send(chatId, `${ACTION_ASK[action] ?? ACTION_BUTTON[action]}: <b>${escapeHtml(r.employee_name)}</b>?`, {
      inline_keyboard: [[{ text: "Да", callback_data: `adm:do:${action}:${id}` }, { text: "Нет", callback_data: `adm:u:${id}` }]],
    });
    return;
  }

  if (kind === "do" || kind === "req") {
    let text: string;
    try {
      const result = await decideCoachUser(id, action, `бот: ${adminName}`, t);
      text = result.ok
        ? `Готово: <b>${escapeHtml(result.employeeName)}</b> — ${ACTION_RESULT[action]}.${result.notified ? "" : "\nСообщение сотруднику доставить не удалось."}`
        : `Не получилось: ${escapeHtml(result.error)}`;
    } catch (e) {
      text = `Не получилось: ${escapeHtml(getErrorMessage(e))}`;
    }
    // Без кнопок: итог решения остаётся в истории чата и не исчезает.
    await t.send(chatId, text);
  }
}

// ---- Условный режим «руководитель» для тестового аккаунта ----
// Те же экраны, но на выдуманных сотрудниках, и ни одно действие ничего не меняет.

const DEMO_STAFF: { id: number; name: string; city: string; status: Row["status"] }[] = [
  { id: 1, name: "Айгерим", city: "Актау", status: "pending" },
  { id: 2, name: "Мадина", city: "Актау", status: "approved" },
  { id: 3, name: "Динара", city: "Актобе", status: "approved" },
  { id: 4, name: "Салтанат", city: "Актобе", status: "disabled" },
];
const DEMO_NOTE = "🧪 <i>Тестовый режим: сотрудники выдуманные, действия ничего не меняют.</i>";

export async function sendDemoStaffList(t: Transport, chatId: number | string, kind: "pending" | "all") {
  const rows = kind === "pending" ? DEMO_STAFF.filter((r) => r.status === "pending") : DEMO_STAFF;
  const title = kind === "pending" ? `🕒 <b>Заявки на подтверждение · ${rows.length}</b>` : `👥 <b>Сотрудники · ${rows.length}</b>`;
  await t.send(chatId, `${DEMO_NOTE}\n\n${title}\nНажмите на имя, чтобы открыть карточку.`, {
    inline_keyboard: rows.map((r) => [{ text: `${STATUS_ICON[r.status]} ${r.name} · ${r.city}`, callback_data: `dm:u:${r.id}` }]),
  });
}

export async function handleDemoCallback(data: string, t: Transport, chatId: number | string, dropCurrent: () => Promise<void>) {
  const parts = data.split(":"); // dm:list | dm:u:<id> | dm:act:<action>
  await dropCurrent();
  const back: ReplyMarkup = { inline_keyboard: [[{ text: "← К списку", callback_data: "dm:list" }]] };
  if (parts[1] === "list") {
    await sendDemoStaffList(t, chatId, "all");
  } else if (parts[1] === "u") {
    const r = DEMO_STAFF.find((x) => x.id === Number(parts[2]));
    if (!r) return;
    const acts: CoachAction[] =
      r.status === "pending" ? ["approve", "reject"] : r.status === "approved" ? ["disable", "remove"] : ["enable", "remove"];
    await t.send(chatId, `${DEMO_NOTE}\n\n<b>${r.name}</b> · ${r.city}\nСтатус: ${STATUS_ICON[r.status]} ${STATUS_TEXT[r.status]}`, {
      inline_keyboard: [acts.map((a) => ({ text: ACTION_BUTTON[a], callback_data: `dm:act:${a}` })), [{ text: "← К списку", callback_data: "dm:list" }]],
    });
  } else if (parts[1] === "act") {
    const a = parts[2] as CoachAction;
    if (!COACH_ACTIONS.includes(a)) return;
    await t.send(
      chatId,
      `${DEMO_NOTE}\n\nВ настоящей системе здесь сработало бы действие «${ACTION_BUTTON[a]}», а сотруднику ушло бы сообщение. В тестовом режиме ничего не изменилось.`,
      back
    );
  }
}

// Заявку отменил сам сотрудник — главный владелец узнаёт об этом (кнопки в старом
// сообщении «Новая заявка» перестанут работать).
export async function notifyAdminsOfCancel(t: Transport, employeeName: string, store: string): Promise<void> {
  try {
    const { data: admins } = await supabaseAdmin
      .from("coach_users")
      .select("telegram_chat_id")
      .eq("is_protected", true)
      .eq("status", "approved");
    for (const a of (admins ?? []) as { telegram_chat_id: number }[]) {
      try {
        await t.send(a.telegram_chat_id, `❎ Заявка отменена сотрудником: <b>${escapeHtml(employeeName)}</b> · ${CITY[store] ?? store}`);
      } catch (e) {
        console.error("coach admin cancel notify error:", getErrorMessage(e));
      }
    }
  } catch (e) {
    console.error("coach admin cancel notify error:", getErrorMessage(e));
  }
}

// Новая заявка — сразу всем администраторам, с кнопками «Принять» / «Отказать».
export async function notifyAdminsOfRequest(t: Transport, telegramUserId: number): Promise<void> {
  try {
    const [{ data: req }, { data: admins }] = await Promise.all([
      supabaseAdmin
        .from("coach_users")
        .select("id, employee_name, store, telegram_name, telegram_username, rejoined, is_admin, admin_scope")
        .eq("telegram_user_id", telegramUserId)
        .maybeSingle(),
      supabaseAdmin
        .from("coach_users")
        .select("telegram_chat_id, store, admin_scope")
        .eq("is_protected", true)
        .eq("status", "approved"),
    ]);
    if (!req) return;
    const r = req as Row & { rejoined: boolean };
    const text = `🆕 <b>Новая заявка${r.rejoined ? " (возвращается)" : ""}</b>\n${escapeHtml(r.employee_name)} · ${CITY[r.store] ?? r.store}${r.is_admin ? ` · роль: ${roleLabel(r)}` : ""}\nTelegram: ${escapeHtml(tgLabel(r))}\nПроверьте, что это именно этот сотрудник.`;
    const markup: ReplyMarkup = {
      inline_keyboard: [[
        { text: "✅ Принять", callback_data: `adm:req:approve:${r.id}` },
        { text: "❌ Отказать", callback_data: `adm:req:reject:${r.id}` },
      ]],
    };
    for (const a of (admins ?? []) as { telegram_chat_id: number; store: string; admin_scope: string }[]) {
      // Заявки принимает только главный владелец — только ему они и приходят.
      if (a.admin_scope !== "all") continue;
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
