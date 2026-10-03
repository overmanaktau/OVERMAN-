// Разбор входящих сообщений бота-помощника: регистрация продавца (выбор города
// и своего имени → заявка владельцу), меню разделов для подтверждённых.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { fetchActiveEmployees } from "@/lib/moysklad";
import { LEAVE_TEXT, REMOVE_KEYBOARD, isOwner, menuFor, roleLabel, type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { ALL_STORES, handleCustomPeriodInput, sendDemoSales, sendSalesStart, setAwaiting } from "@/lib/coach/salesview";
import { handleAdminCallback, handleDemoCallback, notifyAdminsOfCancel, notifyAdminsOfRequest, sendDemoStaffList, sendStaffList } from "@/lib/coach/adminui";
import {
  TEST_BANNER,
  TEST_EMPLOYEE_ID,
  TEST_LABEL,
  demoMonthStatus,
  demoWeekSummary,
  expireTestUser,
  isTestExpired,
} from "@/lib/coach/testmode";
import { ADMIN_HELP_TEXT, CITY_ADMIN_HELP_TEXT, OWNER_VIEW_HELP_TEXT, HELP_MENU_TEXT, HELP_TEXT, SUPPORT_TEXT, adviceMessage, lastWeekMessage, myPlanMessage, weekMessage } from "@/lib/coach/messages";
import { type EmployeeRef, buildAdvice, monthStatus, todayInAlmaty, weekSummary } from "@/lib/coach/metrics";

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
  admin_scope: "city" | "all";
  is_protected: boolean;
  is_test: boolean;
  test_role: "consultant" | "manager" | null;
  test_expires_at: string | null;
  awaiting: string | null;
};

const CITIES: { store: string; label: string }[] = [
  { store: "point_1", label: "Актау" },
  { store: "point_3", label: "Актобе" },
];
// Не показывается в списке при регистрации (Saya Park — не человек). Владельцы и
// администратор (Дамир, Қайнар, Нуржан) в списке есть, роль им назначена заранее
// (таблица coach_role_presets).
const HIDDEN_NAME = /саяпарк|saya/i;

// Города, которые видит администратор: все (владелец) или только свой.
function adminStores(u: CoachUser): string[] {
  return u.admin_scope === "all" ? ALL_STORES : [u.store];
}

export function refOf(u: CoachUser): EmployeeRef {
  return { id: u.employee_ms_id, name: u.employee_name, store: u.store };
}

async function findUser(telegramUserId: number): Promise<CoachUser | null> {
  const { data, error } = await supabaseAdmin.from("coach_users").select("*").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (error) throw error;
  return (data as CoachUser | null) ?? null;
}

// Кого можно выбрать при регистрации: все активные сотрудники МойСклад этого города
// (по истории продаж за всё время), ещё не занятые другим Telegram-аккаунтом.
// Неактивных в МойСклад в списке нет.
async function selectableEmployees(store: string): Promise<{ id: string; name: string }[]> {
  // История продаж по всем городам за всё время (постранично: PostgREST отдаёт не
  // больше 1000 строк за запрос) — по ней сотрудник привязывается к городу.
  const history: { employee_ms_id: string; employee_name: string; store: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("moysklad_employee_sales_daily")
      .select("employee_ms_id, employee_name, store")
      .order("sale_date", { ascending: false })
      .order("employee_ms_id")
      .order("store")
      .range(offset, offset + 999);
    if (error) throw error;
    history.push(...((data ?? []) as { employee_ms_id: string; employee_name: string; store: string }[]));
    if (!data || data.length < 1000) break;
  }
  const taken = await supabaseAdmin.from("coach_users").select("employee_ms_id").in("status", ["pending", "approved"]).eq("is_test", false);
  if (taken.error) throw taken.error;
  // Только активные в МойСклад. Если МойСклад не ответил — ошибка, а не список
  // «на всякий случай»: неактивных сотрудников показывать нельзя.
  const active = await fetchActiveEmployees();
  const activeIds = new Set(active.map((e) => e.id));
  const takenIds = new Set((taken.data ?? []).map((r) => r.employee_ms_id as string));

  const byId = new Map<string, string>();
  const soldAnywhere = new Set<string>();
  for (const r of history) {
    soldAnywhere.add(r.employee_ms_id);
    if (r.store !== store) continue;
    if (HIDDEN_NAME.test(r.employee_name)) continue;
    if (takenIds.has(r.employee_ms_id)) continue;
    if (!activeIds.has(r.employee_ms_id)) continue;
    if (!byId.has(r.employee_ms_id)) byId.set(r.employee_ms_id, r.employee_name); // строки от новых к старым — берём свежее имя
  }
  // Активные, у кого продаж ещё нигде не было, город по истории не определить — показываем в обоих городах.
  for (const e of active) {
    if (soldAnywhere.has(e.id) || takenIds.has(e.id) || HIDDEN_NAME.test(e.name) || !e.name) continue;
    byId.set(e.id, e.name);
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

// Под сообщением «заявка отправлена» — отмена, если выбрал не того сотрудника.
const PENDING_MARKUP: ReplyMarkup = { inline_keyboard: [[{ text: "✖️ Отменить заявку", callback_data: "cancel:req" }]] };

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
  const menu = menuFor(u);
  if (u.is_test) {
    await showTestSection(t, u, section, menu);
    return;
  }
  // У администратора нет ни плана, ни личных продаж — только управление сотрудниками.
  if (u.is_admin && ["plan", "advice", "week", "last"].includes(section)) {
    await t.send(u.telegram_chat_id, "Выберите раздел кнопкой внизу или нажмите «Помощь».", menu);
  } else if (section === "plan") {
    await t.send(u.telegram_chat_id, myPlanMessage(emp, await monthStatus(emp, today)), menu);
  } else if (section === "advice") {
    const s = await monthStatus(emp, today);
    await t.send(u.telegram_chat_id, adviceMessage(emp, s, buildAdvice(s)), menu);
  } else if (section === "week") {
    await t.send(u.telegram_chat_id, weekMessage(emp, await weekSummary(emp, today)), menu);
  } else if (section === "last") {
    await t.send(u.telegram_chat_id, lastWeekMessage(emp, await weekSummary(emp, today)), menu);
  } else if (section === "requests" || section === "staff") {
    // «Сотрудники» смотрят владельцы; «Заявки» — только главный владелец.
    if (section === "requests" ? u.is_protected : isOwner(u)) {
      await sendStaffList(t, u.telegram_chat_id, section === "requests" ? "pending" : "all", adminStores(u));
    } else await t.send(u.telegram_chat_id, "Выберите раздел кнопкой внизу или нажмите «Помощь».", menu);
  } else if (section === "sales") {
    if (u.is_admin) await sendSalesStart(t, u.telegram_chat_id, adminStores(u));
    else await t.send(u.telegram_chat_id, "Выберите раздел кнопкой внизу или нажмите «Помощь».", menu);
  } else if (section === "exit") {
    if (u.is_protected) await t.send(u.telegram_chat_id, "Главный владелец не может выйти из аккаунта.", menu);
    else await t.send(u.telegram_chat_id, EXIT_CONFIRM_TEXT, EXIT_CONFIRM_KEYBOARD);
  } else {
    await t.send(u.telegram_chat_id, HELP_MENU_TEXT, HELP_MENU_KEYBOARD);
  }
}

// Тестовый аккаунт: те же разделы, но на условных данных. Консультант видит свои
// разделы, руководитель — «Заявки» и «Сотрудники» на выдуманных сотрудниках.
async function showTestSection(t: Transport, u: CoachUser, section: string, menu: ReplyMarkup) {
  const chat = u.telegram_chat_id;
  const manager = u.test_role === "manager";
  const today = todayInAlmaty();
  const emp: EmployeeRef = { id: TEST_EMPLOYEE_ID, name: "Тестовый консультант", store: u.store };
  if (section === "help") {
    await t.send(chat, HELP_MENU_TEXT, HELP_MENU_KEYBOARD);
  } else if (section === "exit") {
    await t.send(chat, EXIT_CONFIRM_TEXT, EXIT_CONFIRM_KEYBOARD);
  } else if (manager && (section === "requests" || section === "staff")) {
    await sendDemoStaffList(t, chat, section === "requests" ? "pending" : "all");
  } else if (manager && section === "sales") {
    await sendDemoSales(t, chat);
  } else if (!manager && section === "plan") {
    await t.send(chat, TEST_BANNER + myPlanMessage(emp, demoMonthStatus(today)), menu);
  } else if (!manager && section === "advice") {
    const s = demoMonthStatus(today);
    await t.send(chat, TEST_BANNER + adviceMessage(emp, s, buildAdvice(s)), menu);
  } else if (!manager && section === "week") {
    await t.send(chat, TEST_BANNER + weekMessage(emp, demoWeekSummary(today)), menu);
  } else if (!manager && section === "last") {
    await t.send(chat, TEST_BANNER + lastWeekMessage(emp, demoWeekSummary(today)), menu);
  } else {
    await t.send(chat, "Выберите раздел кнопкой внизу или нажмите «Помощь».", menu);
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
  продажи: "sales",
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

  // Срок тестового аккаунта вышел — выводим сразу, не дожидаясь расписания.
  if (user && isTestExpired(user)) {
    await expireTestUser(user, t);
    return;
  }

  if (user && user.status === "approved") {
    // Чат мог поменяться — держим актуальным.
    if (user.telegram_chat_id !== chatId) {
      await supabaseAdmin.from("coach_users").update({ telegram_chat_id: chatId }).eq("id", user.id);
      user.telegram_chat_id = chatId;
    }
    if (text === "/start") {
      await t.send(chatId, `Здравствуйте, ${escapeHtml(user.employee_name)}!${user.is_admin && !user.is_test ? ` Ваша роль: ${roleLabel(user)}.` : ""} Выберите раздел внизу.`, menuFor(user));
      return;
    }
    const section = SECTION_BY_TEXT[text.toLowerCase()];
    // Бот ждёт свой период для «Продаж»: любой текст, кроме кнопок меню, — это ввод дат.
    if (user.awaiting?.startsWith("sales:") && user.is_admin && !section) {
      await handleCustomPeriodInput(t, user, user.awaiting, text, adminStores(user));
      return;
    }
    if (user.awaiting) await setAwaiting(user.id, null);
    if (section) {
      await showSection(t, user, section);
    } else {
      await t.send(chatId, "Выберите раздел кнопкой внизу или нажмите «Помощь».", menuFor(user));
    }
    return;
  }

  if (!user || user.status === "left" || (user.status === "rejected" && text === "/start")) {
    await askCity(t, chatId);
    return;
  }
  await t.send(chatId, statusText(user), user.status === "pending" ? PENDING_MARKUP : REMOVE_KEYBOARD);
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

  // То же, но сообщение остаётся в истории — убираются только кнопки.
  const clearCurrent = async () => {
    if (messageId === undefined) return;
    try {
      await t.clearButtons(chatId, messageId);
    } catch {
      // оставляем как есть
    }
  };

  const existing = await findUser(cb.from.id);

  if (existing && isTestExpired(existing)) {
    await dropCurrent();
    await expireTestUser(existing, t);
    return;
  }

  if (cb.data.startsWith("help:")) {
    if (!existing || existing.status !== "approved") return;
    await dropCurrent();
    if (cb.data === "help:learn") await t.send(chatId, !existing.is_admin ? HELP_TEXT : existing.is_protected ? ADMIN_HELP_TEXT : isOwner(existing) ? OWNER_VIEW_HELP_TEXT : CITY_ADMIN_HELP_TEXT, HELP_BACK_KEYBOARD);
    else if (cb.data === "help:support") await t.send(chatId, SUPPORT_TEXT, HELP_BACK_KEYBOARD);
    else await t.send(chatId, HELP_MENU_TEXT, HELP_MENU_KEYBOARD);
    return;
  }

  if (cb.data.startsWith("exit:")) {
    if (!existing || existing.status !== "approved") return;
    await dropCurrent();
    if (cb.data === "exit:yes") {
      if (existing.is_protected) return; // главный владелец выйти не может
      const { error } = await supabaseAdmin
        .from("coach_users")
        // Вышедший теряет и роль: вернётся — снова обычным сотрудником.
        .update({ status: "left", left_at: new Date().toISOString(), is_admin: false, admin_scope: "city", awaiting: null })
        .eq("id", existing.id);
      if (error) throw error;
      await t.send(chatId, LEAVE_TEXT, REMOVE_KEYBOARD);
    } else {
      await t.send(chatId, "Остаётесь в системе. Выберите раздел кнопкой внизу.", menuFor(existing));
    }
    return;
  }

  if (cb.data.startsWith("dm:")) {
    // Условный режим «руководитель» — только для тестового аккаунта в этой роли.
    if (!existing || existing.status !== "approved" || !existing.is_test || existing.test_role !== "manager") return;
    await handleDemoCallback(cb.data, t, chatId, dropCurrent);
    return;
  }

  if (cb.data.startsWith("adm:")) {
    // Только подтверждённый администратор; от остальных нажатия молча игнорируем.
    if (!existing || existing.status !== "approved" || !existing.is_admin || existing.is_test) return;
    await handleAdminCallback(cb.data, t, chatId, existing.employee_name, dropCurrent, clearCurrent, adminStores(existing), isOwner(existing), existing.id, existing.is_protected);
    return;
  }

  if (cb.data === "cancel:req") {
    await dropCurrent();
    if (!existing || existing.status !== "pending") {
      await t.send(chatId, "Активной заявки нет. Чтобы подать заявку, нажмите /start.", REMOVE_KEYBOARD);
      return;
    }
    // Тот, кто раньше выходил (rejoined), остаётся «вышедшим», остальные — запись удаляется
    // совсем, чтобы повторная заявка не выглядела как возвращение.
    const { error } = existing.rejoined
      ? await supabaseAdmin
          .from("coach_users")
          .update({ status: "left", left_at: new Date().toISOString(), is_admin: false, admin_scope: "city", awaiting: null })
          .eq("id", existing.id)
      : await supabaseAdmin.from("coach_users").delete().eq("id", existing.id);
    if (error) throw error;
    await t.send(chatId, "Заявка отменена. Если ошиблись, выберите город заново:", cityKeyboard());
    await notifyAdminsOfCancel(t, existing.employee_name, existing.store);
    return;
  }

  if (existing && existing.status !== "rejected" && existing.status !== "left") {
    await dropCurrent();
    await t.send(chatId, statusText(existing) || "Вы уже зарегистрированы.", existing.status === "approved" ? menuFor(existing) : existing.status === "pending" ? PENDING_MARKUP : undefined);
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
    const city = CITIES.find((c) => c.store === store)?.label ?? "";
    const heading =
      employees.length === 0
        ? `Город: <b>${city}</b>. Свободных сотрудников пока нет — обратитесь к руководителю или посмотрите тестовый аккаунт:`
        : `Город: <b>${city}</b>. Выберите себя в списке:`;
    await t.send(chatId, heading, {
      inline_keyboard: [
        ...employees.map((e) => [{ text: e.name, callback_data: `emp:${store}:${e.id}` }]),
        [{ text: TEST_LABEL, callback_data: `emp:${store}:${TEST_EMPLOYEE_ID}` }],
        [{ text: "← Назад", callback_data: "back" }],
      ],
    });
    return;
  }

  if (cb.data.startsWith("emp:")) {
    const [, store, employeeId] = cb.data.split(":");
    if (employeeId === TEST_EMPLOYEE_ID) {
      // Тестовый сотрудник никогда не занят: спрашиваем, что именно показать.
      if (!CITIES.some((c) => c.store === store)) return;
      await dropCurrent();
      await t.send(chatId, `${TEST_LABEL}. Что вы хотите посмотреть?`, {
        inline_keyboard: [
          [{ text: "Консультанта", callback_data: `trole:${store}:consultant` }],
          [{ text: "Руководителя", callback_data: `trole:${store}:manager` }],
          [{ text: "← Назад", callback_data: `city:${store}` }],
        ],
      });
      return;
    }
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
    await submitRequest(t, cb, chatId, existing, {
      store,
      employee_ms_id: chosen.id,
      employee_name: chosen.name,
      rejoined: (leftBefore ?? 0) > 0,
      is_test: false,
      test_role: null,
    });
    return;
  }

  if (cb.data.startsWith("trole:")) {
    const [, store, role] = cb.data.split(":");
    if (!CITIES.some((c) => c.store === store) || (role !== "consultant" && role !== "manager")) return;
    await dropCurrent();
    await submitRequest(t, cb, chatId, existing, {
      store,
      employee_ms_id: TEST_EMPLOYEE_ID,
      employee_name: `Тестовый сотрудник (${role === "manager" ? "руководитель" : "консультант"})`,
      rejoined: false,
      is_test: true,
      test_role: role,
    });
  }
}

// Заявка на подключение: создаёт или обновляет запись, говорит об этом человеку
// и сразу уведомляет администраторов бота.
async function submitRequest(
  t: Transport,
  cb: NonNullable<TgUpdate["callback_query"]>,
  chatId: number,
  existing: CoachUser | null,
  who: Pick<CoachUser, "store" | "employee_ms_id" | "employee_name" | "rejoined" | "is_test" | "test_role">
): Promise<void> {
  // Роль, назначенная заранее этому сотруднику (владелец / администратор); у остальных — обычная.
  const { data: preset, error: presetError } = who.is_test
    ? { data: null, error: null }
    : await supabaseAdmin.from("coach_role_presets").select("role").eq("employee_ms_id", who.employee_ms_id).maybeSingle();
  if (presetError) throw presetError;
  const presetRole = (preset as { role: "owner" | "city_admin" } | null)?.role ?? null;
  const row = {
    ...who,
    is_admin: presetRole !== null,
    admin_scope: presetRole === "owner" ? "all" : "city",
    awaiting: null,
    left_at: null,
    test_expires_at: null,
    telegram_user_id: cb.from.id,
    telegram_chat_id: chatId,
    telegram_username: cb.from.username ?? null,
    telegram_name: [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ") || null,
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
    `${who.rejoined ? "С возвращением! " : ""}Заявка отправлена: <b>${escapeHtml(who.employee_name)}</b>. Руководитель должен подтвердить, что это вы. Как только подтвердит, вам придёт сообщение.\n\nВыбрали не того? Заявку можно отменить.`,
    PENDING_MARKUP
  );
  await notifyAdminsOfRequest(t, cb.from.id);
}
