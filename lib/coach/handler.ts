// Разбор входящих сообщений бота-помощника: регистрация продавца (выбор города
// и своего имени → заявка владельцу), меню разделов для подтверждённых.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { fetchActiveEmployeeIds } from "@/lib/moysklad";
import { LEAVE_TEXT, REMOVE_KEYBOARD, menuFor, type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { handleAdminCallback, notifyAdminsOfRequest, sendStaffList } from "@/lib/coach/adminui";
import { HELP_MENU_TEXT, HELP_TEXT, SUPPORT_TEXT, adviceMessage, lastWeekMessage, myPlanMessage, weekMessage } from "@/lib/coach/messages";
import { type EmployeeRef, addDays, buildAdvice, monthStatus, todayInAlmaty, weekSummary } from "@/lib/coach/metrics";

export type TgUser = { id: number; username?: string; first_name?: string; last_name?: string };
export type TgUpdate = {
  message?: { chat: { id: number; type: string }; from?: TgUser; text?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id?: number; chat: { id: number; type: string } } };
};

export type CoachUser = {
  id: number;
  telegram_user_id: number;
  telegram_chat_id: number;
  store: string;
  employee_ms_id: string;
  employee_name: string;
  status: "pending" | "approved" | "rejected" | "disabled" | "left";
  rejoined: boolean;
  is_admin: boolean;
};

const CITIES: { store: string; label: string }[] = [
  { store: "point_1", label: "Актау" },
  { store: "point_3", label: "Актобе" },
];
const LOOKBACK_DAYS = 45;
// Не показываются в списке при регистрации (Saya Park, директор, Қайнар).
const HIDDEN_NAME = /саяпарк|saya|дамир\s+директор|[кқ]айнар/i;

export function refOf(u: CoachUser): EmployeeRef {
  return { id: u.employee_ms_id, name: u.employee_name, store: u.store };
}

async function findUser(telegramUserId: number): Promise<CoachUser | null> {
  const { data, error } = await supabaseAdmin.from("coach_users").select("*").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (error) throw error;
  return (data as CoachUser | null) ?? null;
}

// Кого можно выбрать при регистрации: продавцы точки за последние дни, только
// активные в МойСклад, ещё не занятые другим Telegram-аккаунтом.
async function selectableEmployees(store: string): Promise<{ id: string; name: string }[]> {
  const from = addDays(todayInAlmaty(), -LOOKBACK_DAYS);
  const [staff, taken] = await Promise.all([
    supabaseAdmin.from("moysklad_employee_sales_daily").select("employee_ms_id, employee_name").eq("store", store).gte("sale_date", from),
    supabaseAdmin.from("coach_users").select("employee_ms_id").in("status", ["pending", "approved"]),
  ]);
  if (staff.error) throw staff.error;
  if (taken.error) throw taken.error;
  // Только активные в МойСклад. Если МойСклад не ответил — ошибка, а не список
  // «на всякий случай»: неактивных сотрудников показывать нельзя.
  const activeIds = new Set(await fetchActiveEmployeeIds());
  const takenIds = new Set((taken.data ?? []).map((r) => r.employee_ms_id as string));
  const byId = new Map<string, string>();
  for (const r of (staff.data ?? []) as { employee_ms_id: string; employee_name: string }[]) {
    if (HIDDEN_NAME.test(r.employee_name)) continue;
    if (takenIds.has(r.employee_ms_id)) continue;
    if (!activeIds.has(r.employee_ms_id)) continue;
    byId.set(r.employee_ms_id, r.employee_name);
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function cityKeyboard(): ReplyMarkup {
  return { inline_keyboard: CITIES.map((c) => [{ text: c.label, callback_data: `city:${c.store}` }]) };
}

async function askCity(t: Transport, chatId: number) {
  await t.send(
    chatId,
    "Добро пожаловать! Я помощник стилиста-консультанта Overman: показываю план/факт и подсказываю, что повысить, чтобы закрыть план.\n\nВыберите ваш город:",
    cityKeyboard()
  );
}

function statusText(u: CoachUser): string {
  switch (u.status) {
    case "pending":
      return `Ваша заявка (${escapeHtml(u.employee_name)}) отправлена руководителю. Как только её подтвердят, бот заработает — вам придёт сообщение.`;
    case "rejected":
      return "Заявку отклонили. Если это ошибка, нажмите /start и отправьте её заново или обратитесь к руководителю.";
    case "disabled":
      return "Доступ к боту отключён. Обратитесь к руководителю.";
    case "left":
      return "Вы вышли из аккаунта. Чтобы войти снова, нажмите /start.";
    default:
      return "";
  }
}

async function showSection(t: Transport, u: CoachUser, section: string) {
  const emp = refOf(u);
  const today = todayInAlmaty();
  const menu = menuFor(u.is_admin);
  if (section === "plan") {
    await t.send(u.telegram_chat_id, myPlanMessage(emp, await monthStatus(emp, today)), menu);
  } else if (section === "advice") {
    const s = await monthStatus(emp, today);
    await t.send(u.telegram_chat_id, adviceMessage(emp, s, buildAdvice(s)), menu);
  } else if (section === "week") {
    await t.send(u.telegram_chat_id, weekMessage(emp, await weekSummary(emp, today)), menu);
  } else if (section === "last") {
    await t.send(u.telegram_chat_id, lastWeekMessage(emp, await weekSummary(emp, today)), menu);
  } else if (section === "requests" || section === "staff") {
    if (u.is_admin) await sendStaffList(t, u.telegram_chat_id, section === "requests" ? "pending" : "all");
    else await t.send(u.telegram_chat_id, "Выберите раздел кнопкой внизу или нажмите «Помощь».", menu);
  } else if (section === "exit") {
    if (u.is_admin) await t.send(u.telegram_chat_id, "Администратор бота не может выйти из аккаунта — иначе вы потеряете управление сотрудниками.", menu);
    else await t.send(u.telegram_chat_id, EXIT_CONFIRM_TEXT, EXIT_CONFIRM_KEYBOARD);
  } else {
    await t.send(u.telegram_chat_id, HELP_MENU_TEXT, HELP_MENU_KEYBOARD);
  }
}

// «Выход» отвязывает аккаунт: чтобы вернуться, регистрацию нужно пройти заново.
const EXIT_CONFIRM_TEXT =
  "Выйти из аккаунта? Бот перестанет присылать вам сообщения. Чтобы вернуться, нужно будет заново выбрать город и имя и дождаться подтверждения руководителя.";
const EXIT_CONFIRM_KEYBOARD: ReplyMarkup = {
  inline_keyboard: [[{ text: "Да, выйти", callback_data: "exit:yes" }, { text: "Отмена", callback_data: "exit:no" }]],
};

// «Помощь» открывает два выбора: обучение (как пользоваться кнопками) и поддержка.
const HELP_MENU_KEYBOARD: ReplyMarkup = {
  inline_keyboard: [
    [{ text: "📚 Обучение", callback_data: "help:learn" }],
    [{ text: "💬 Поддержка", callback_data: "help:support" }],
  ],
};
const HELP_BACK_KEYBOARD: ReplyMarkup = { inline_keyboard: [[{ text: "← Назад", callback_data: "help:menu" }]] };

const SECTION_BY_TEXT: Record<string, string> = {
  "мой план": "plan",
  "/plan": "plan",
  "что повысить": "advice",
  "/advice": "advice",
  "план на неделю": "week",
  "/week": "week",
  "итоги прошлой недели": "last",
  "/last": "last",
  помощь: "help",
  выход: "exit",
  "/exit": "exit",
  заявки: "requests",
  сотрудники: "staff",
  "/help": "help",
};

export async function handleUpdate(update: TgUpdate, t: Transport): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, t);
    return;
  }
  const msg = update.message;
  if (!msg || msg.chat.type !== "private" || !msg.from) return; // бот работает только в личных чатах
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  const user = await findUser(msg.from.id);

  if (user && user.status === "approved") {
    // Чат мог поменяться — держим актуальным.
    if (user.telegram_chat_id !== chatId) {
      await supabaseAdmin.from("coach_users").update({ telegram_chat_id: chatId }).eq("id", user.id);
      user.telegram_chat_id = chatId;
    }
    if (text === "/start") {
      await t.send(chatId, `Здравствуйте, ${escapeHtml(user.employee_name)}! Выберите раздел внизу.`, menuFor(user.is_admin));
      return;
    }
    const section = SECTION_BY_TEXT[text.toLowerCase()];
    if (section) {
      await showSection(t, user, section);
    } else {
      await t.send(chatId, "Выберите раздел кнопкой внизу или нажмите «Помощь».", menuFor(user.is_admin));
    }
    return;
  }

  if (!user || user.status === "left" || (user.status === "rejected" && text === "/start")) {
    await askCity(t, chatId);
    return;
  }
  await t.send(chatId, statusText(user), REMOVE_KEYBOARD);
}

async function handleCallback(cb: NonNullable<TgUpdate["callback_query"]>, t: Transport): Promise<void> {
  const chatId = cb.message?.chat.id;
  if (!chatId || cb.message?.chat.type !== "private" || !cb.data) return;
  await t.answerCallback(cb.id);

  // Выбор сделан — сообщение с кнопками сразу убираем, на его месте появляется
  // следующий шаг. Удалить можно не всегда (старше 48 часов) — это не критично.
  const messageId = cb.message?.message_id;
  const dropCurrent = async () => {
    if (messageId === undefined) return;
    try {
      await t.deleteMessage(chatId, messageId);
    } catch {
      // оставляем как есть
    }
  };

  const existing = await findUser(cb.from.id);

  if (cb.data.startsWith("help:")) {
    if (!existing || existing.status !== "approved") return;
    await dropCurrent();
    if (cb.data === "help:learn") await t.send(chatId, HELP_TEXT, HELP_BACK_KEYBOARD);
    else if (cb.data === "help:support") await t.send(chatId, SUPPORT_TEXT, HELP_BACK_KEYBOARD);
    else await t.send(chatId, HELP_MENU_TEXT, HELP_MENU_KEYBOARD);
    return;
  }

  if (cb.data.startsWith("exit:")) {
    if (!existing || existing.status !== "approved") return;
    await dropCurrent();
    if (cb.data === "exit:yes") {
      const { error } = await supabaseAdmin
        .from("coach_users")
        .update({ status: "left", left_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw error;
      await t.send(chatId, LEAVE_TEXT, REMOVE_KEYBOARD);
    } else {
      await t.send(chatId, "Остаётесь в системе. Выберите раздел кнопкой внизу.", menuFor(existing.is_admin));
    }
    return;
  }

  if (cb.data.startsWith("adm:")) {
    // Только подтверждённый администратор; от остальных нажатия молча игнорируем.
    if (!existing || existing.status !== "approved" || !existing.is_admin) return;
    await handleAdminCallback(cb.data, t, chatId, existing.employee_name, dropCurrent);
    return;
  }

  if (existing && existing.status !== "rejected" && existing.status !== "left") {
    await dropCurrent();
    await t.send(chatId, statusText(existing) || "Вы уже зарегистрированы.", existing.status === "approved" ? menuFor(existing.is_admin) : undefined);
    return;
  }

  if (cb.data === "back") {
    await dropCurrent();
    await t.send(chatId, "Выберите ваш город:", cityKeyboard());
    return;
  }

  if (cb.data.startsWith("city:")) {
    const store = cb.data.slice(5);
    if (!CITIES.some((c) => c.store === store)) return;
    let employees: { id: string; name: string }[];
    try {
      employees = await selectableEmployees(store);
    } catch {
      await t.send(chatId, "Не удалось получить список сотрудников из МойСклад. Нажмите на город ещё раз через минуту.");
      return;
    }
    await dropCurrent();
    if (employees.length === 0) {
      await t.send(chatId, "В этом городе пока нет свободных сотрудников для выбора. Обратитесь к руководителю.", {
        inline_keyboard: [[{ text: "← Назад", callback_data: "back" }]],
      });
      return;
    }
    const city = CITIES.find((c) => c.store === store)?.label ?? "";
    await t.send(chatId, `Город: <b>${city}</b>. Выберите себя в списке:`, {
      inline_keyboard: [
        ...employees.map((e) => [{ text: e.name, callback_data: `emp:${store}:${e.id}` }]),
        [{ text: "← Назад", callback_data: "back" }],
      ],
    });
    return;
  }

  if (cb.data.startsWith("emp:")) {
    const [, store, employeeId] = cb.data.split(":");
    let employees: { id: string; name: string }[];
    try {
      employees = await selectableEmployees(store);
    } catch {
      await t.send(chatId, "Не удалось проверить сотрудника в МойСклад. Нажмите на своё имя ещё раз через минуту.");
      return;
    }
    const chosen = employees.find((e) => e.id === employeeId);
    await dropCurrent();
    if (!chosen) {
      await t.send(chatId, "Этот сотрудник уже занят или недоступен. Нажмите /start и выберите ещё раз, либо обратитесь к руководителю.");
      return;
    }
    // Сотрудник, который раньше выходил из системы, входит как вернувшийся.
    const { count: leftBefore, error: leftError } = await supabaseAdmin
      .from("coach_users")
      .select("id", { count: "exact", head: true })
      .eq("employee_ms_id", chosen.id)
      .eq("status", "left");
    if (leftError) throw leftError;
    const rejoined = (leftBefore ?? 0) > 0;
    const row = {
      rejoined,
      left_at: null,
      telegram_user_id: cb.from.id,
      telegram_chat_id: chatId,
      telegram_username: cb.from.username ?? null,
      telegram_name: [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ") || null,
      store,
      employee_ms_id: chosen.id,
      employee_name: chosen.name,
      status: "pending",
      requested_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    };
    const { error } = existing
      ? await supabaseAdmin.from("coach_users").update(row).eq("id", existing.id)
      : await supabaseAdmin.from("coach_users").insert(row);
    if (error) {
      await t.send(chatId, "Не удалось отправить заявку — возможно, этого сотрудника уже выбрал другой человек. Обратитесь к руководителю.");
      return;
    }
    await t.send(
      chatId,
      `${rejoined ? "С возвращением! " : ""}Заявка отправлена: <b>${escapeHtml(chosen.name)}</b>. Руководитель должен подтвердить, что это вы. Как только подтвердит, вам придёт сообщение.`,
      REMOVE_KEYBOARD
    );
    await notifyAdminsOfRequest(t, cb.from.id);
  }
}
