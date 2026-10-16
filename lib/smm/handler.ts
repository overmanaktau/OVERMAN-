// Обработка сообщений и кнопок бота СММ: заявка на доступ (роль выбирает человек, подтверждает владелец через бота-помощника), меню по ролям,
// таргет, аналитика постов, истории, продажи по категориям, онлайн-продажи, расход на рекламу.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { escapeHtml } from "@/lib/telegram";
import { todayInAlmaty } from "@/lib/coach/metrics";
import { CITIES, ROLE_TITLE, SMM_ROLES, citiesOf, type CityKey, type SmmRole } from "@/lib/smm/config";
import { MAX_DAYS, PERIOD_BUTTONS, codeFromPeriod, daysIn, parseCustomPeriod, periodFromCode, type Period } from "@/lib/smm/periods";
import { allPostsText, postsReport, spendText, targetReport } from "@/lib/smm/reports";
import { listPosts } from "@/lib/smm/meta";
import { categoryProducts, categorySales, onlineProducts, onlineSales, productsMessage } from "@/lib/smm/sales";
import { cityCode, cityFromCode, sendCategories, sendLong, sendStories } from "@/lib/smm/flows";
import { storiesList } from "@/lib/smm/stories";
import { notifyOwnerOfRequest } from "@/lib/smm/approvals";
import { BTN, canUse, menuFor, type Feat } from "@/lib/smm/menu";
import type { ReplyMarkup, Transport } from "@/lib/smm/telegram";
import type { SmmUser } from "@/lib/smm/users";

export type SmmUpdate = {
  message?: { chat: { id: number; type: string }; from?: { id: number; username?: string; first_name?: string; last_name?: string }; text?: string };
  callback_query?: { id: string; from: { id: number; username?: string; first_name?: string; last_name?: string }; message?: { chat: { id: number }; message_id: number }; data?: string };
};

const fullName = (f: { first_name?: string; last_name?: string; username?: string }) => [f.first_name, f.last_name].filter(Boolean).join(" ") || f.username || "Без имени";

async function getUser(telegramId: number): Promise<SmmUser | null> {
  const { data, error } = await supabaseAdmin.from("smm_users").select("*").eq("telegram_user_id", telegramId).maybeSingle();
  if (error) throw error;
  return (data as SmmUser | null) ?? null;
}

async function setAwaiting(u: SmmUser, awaiting: string | null) {
  await supabaseAdmin.from("smm_users").update({ awaiting }).eq("id", u.id);
  u.awaiting = awaiting;
}

// ---------- запуск функций ----------

function periodKeyboard(feat: Feat, code: string): ReplyMarkup {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < PERIOD_BUTTONS.length; i += 2) rows.push(PERIOD_BUTTONS.slice(i, i + 2).map((b) => ({ text: b.text, callback_data: `p|${feat}|${code}|${b.code}` })));
  rows.push([{ text: "✏️ Свой период", callback_data: `p|${feat}|${code}|x` }]);
  return { inline_keyboard: rows };
}

function citiesFromCode(user: SmmUser, code: string): CityKey[] {
  const allowed = citiesOf(user.role);
  const wanted: CityKey[] = code === "ab" ? ["aktau", "aktobe"] : ((cityFromCode(code) ? [cityFromCode(code)] : []) as CityKey[]);
  return wanted.filter((c) => allowed.includes(c));
}

const FEAT_ASKS_PERIOD: Record<Feat, boolean> = { tg: true, ps: true, st: true, cs: true, on: true, sp: true };

async function startFeature(t: Transport, u: SmmUser, chat: number, feat: Feat) {
  if (!canUse(u.role, feat)) {
    await t.send(chat, "Этот раздел вам недоступен.");
    return;
  }
  const cities = feat === "on" ? (["aktau"] as CityKey[]) : feat === "sp" ? [] : citiesOf(u.role);
  if (feat === "sp") {
    await t.send(chat, "За какой период показать расход на рекламу?", periodKeyboard(feat, "ab"));
    return;
  }
  if (cities.length === 1) {
    await afterCity(t, u, chat, feat, cityCode(cities[0]));
    return;
  }
  const rows = cities.map((c) => [{ text: CITIES[c].title, callback_data: `c|${feat}|${cityCode(c)}` }]);
  if (feat !== "ps") rows.push([{ text: "Оба города", callback_data: `c|${feat}|ab` }]);
  await t.send(chat, "Какой город?", { inline_keyboard: rows });
}

async function afterCity(t: Transport, u: SmmUser, chat: number, feat: Feat, code: string) {
  if (!FEAT_ASKS_PERIOD[feat]) {
    await runFeature(t, u, chat, feat, code, null);
    return;
  }
  await t.send(chat, "За какой период?", periodKeyboard(feat, code));
}

async function runFeature(t: Transport, u: SmmUser, chat: number, feat: Feat, code: string, p: Period | null) {
  if (!canUse(u.role, feat)) return;
  const cities = feat === "sp" ? [] : citiesFromCode(u, code);
  if (feat !== "sp" && cities.length === 0) {
    await t.send(chat, "Этот город вам недоступен.");
    return;
  }
  if (p && feat === "ps" && daysIn(p) > MAX_DAYS) {
    await t.send(chat, `Период слишком длинный (больше ${MAX_DAYS} дней). Выберите покороче.`);
    return;
  }
  await t.send(chat, "⏳ Собираю данные…");
  try {
    if (feat === "tg" && p) {
      for (const c of cities) for (const part of await targetReport(c, p)) await t.send(chat, part);
    } else if (feat === "ps" && p) {
      const r = await postsReport(cities[0], p);
      await t.send(chat, r.text, r.data.posts.length > 0 ? { inline_keyboard: [[{ text: "📃 Все публикации", callback_data: `pl|${cityCode(cities[0])}|${codeFromPeriod(p)}` }]] } : undefined);
    } else if (feat === "st" && p) {
      for (const c of cities) await sendStories(t, chat, c, p);
    } else if (feat === "cs" && p) {
      for (const c of cities) await sendCategories(t, chat, c, p, "all");
    } else if (feat === "on" && p) {
      await sendCategories(t, chat, "aktau", p, "online");
    } else if (feat === "sp" && p) {
      await t.send(chat, await spendText(p));
    }
  } catch (e) {
    await t.send(chat, `⚠️ Не получилось: ${escapeHtml(getErrorMessage(e))}`);
  }
}

// ---------- выбор категорий для списка товаров ----------

type PickState = { feat: "cs" | "on"; city: CityKey; from: string; to: string; cats: string[]; sel: boolean[] };

function pickKeyboard(p: PickState): ReplyMarkup {
  const rows = p.cats.map((c, i) => [{ text: `${p.sel[i] ? "✅" : "⬜️"} ${c}`, callback_data: `k|t|${i}` }]);
  rows.push([{ text: p.sel.every(Boolean) ? "Снять все" : "Выбрать все", callback_data: "k|a" }]);
  rows.push([{ text: "📋 Показать товары", callback_data: "k|go" }]);
  return { inline_keyboard: rows };
}
const PICK_TEXT = "Выберите категории (одну, несколько или все) и нажмите «Показать товары».";

async function startPick(t: Transport, u: SmmUser, chat: number, feat: "cs" | "on", city: CityKey, p: Period) {
  const report = feat === "on" ? (await onlineSales(p)).report : await categorySales(city, p);
  if (report.rows.length === 0) {
    await t.send(chat, "За этот период продаж нет.");
    return;
  }
  const pick: PickState = { feat, city, from: p.from, to: p.to, cats: report.rows.map((r) => r.category), sel: report.rows.map(() => false) };
  await supabaseAdmin.from("smm_users").update({ state: { pick } }).eq("id", u.id);
  await t.send(chat, PICK_TEXT, pickKeyboard(pick));
}

// ---------- обработка сообщений ----------

export async function handleSmmUpdate(update: SmmUpdate, t: Transport): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query, t);
  const msg = update.message;
  if (!msg || msg.chat.type !== "private" || !msg.from) return;
  const chat = msg.chat.id;
  const text = (msg.text ?? "").trim();
  const user = await getUser(msg.from.id);

  if (/^\/start(\s|@|$)/i.test(text) || (!user && text)) {
    if (user?.status === "approved") {
      await t.send(chat, "Вы уже в боте. Выберите раздел кнопкой внизу.", menuFor(user.role));
      return;
    }
    if (user?.status === "pending") {
      await t.send(chat, "Заявка уже отправлена и ждёт подтверждения администратора.");
      return;
    }
    if (user?.status === "disabled") {
      await t.send(chat, "Доступ к боту отключён. Обратитесь к руководителю.");
      return;
    }
    await t.send(chat, "Здравствуйте! Это бот <b>OVERMAN</b> для СММ.\n\nВыберите свою должность — заявку подтвердит администратор.", {
      inline_keyboard: SMM_ROLES.map((r) => [{ text: ROLE_TITLE[r], callback_data: `rg|${r}` }]),
    });
    return;
  }
  if (!user) return;
  if (user.status === "pending") {
    await t.send(chat, "Заявка ждёт подтверждения администратора.");
    return;
  }
  if (user.status !== "approved") {
    await t.send(chat, user.status === "disabled" ? "Доступ к боту отключён. Обратитесь к руководителю." : "Чтобы войти, нажмите /start.");
    return;
  }

  if (/^\/(menu|cancel)(\s|@|$)/i.test(text)) {
    await setAwaiting(user, null);
    await t.send(chat, "Выберите раздел кнопкой внизу.", menuFor(user.role));
    return;
  }
  const feat = (Object.keys(BTN) as Feat[]).find((f) => BTN[f] === text);
  if (feat) {
    await setAwaiting(user, null);
    await startFeature(t, user, chat, feat);
    return;
  }
  if (user.awaiting?.startsWith("custom|")) {
    const [, f, code] = user.awaiting.split("|");
    const p = parseCustomPeriod(text, todayInAlmaty());
    if (!p) {
      await t.send(chat, "Не понял период. Напишите так: <code>01.10-15.10</code> (или одну дату <code>15.10</code>). Отмена: /cancel");
      return;
    }
    await setAwaiting(user, null);
    await runFeature(t, user, chat, f as Feat, code, p);
    return;
  }
  await t.send(chat, "Выберите раздел кнопкой внизу.", menuFor(user.role));
}

async function handleCallback(cb: NonNullable<SmmUpdate["callback_query"]>, t: Transport): Promise<void> {
  const chat = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const [kind, ...args] = (cb.data ?? "").split("|");
  if (!chat) return;
  const user = await getUser(cb.from.id);

  // выбор должности — до подтверждения
  if (kind === "rg") {
    await t.answer(cb.id);
    const role = args[0] as SmmRole;
    if (!SMM_ROLES.includes(role)) return;
    if (user?.status === "approved" || user?.status === "pending") {
      await t.send(chat, user.status === "approved" ? "Вы уже в боте." : "Заявка уже отправлена.");
      return;
    }
    const { data, error } = await supabaseAdmin
      .from("smm_users")
      .upsert({ telegram_user_id: cb.from.id, telegram_chat_id: chat, username: cb.from.username ?? null, name: fullName(cb.from), role, status: "pending", requested_at: new Date().toISOString(), decided_at: null, awaiting: null }, { onConflict: "telegram_user_id" })
      .select("*")
      .single();
    if (error) throw error;
    await t.send(chat, `Заявка отправлена: ${ROLE_TITLE[role]}. Когда администратор подтвердит, придёт сообщение.`);
    await notifyOwnerOfRequest(data as SmmUser);
    return;
  }

  if (!user || user.status !== "approved") {
    await t.answer(cb.id, "Нет доступа");
    return;
  }
  const me = user;
  await t.answer(cb.id);
  const today = todayInAlmaty();

  if (kind === "c") {
    await afterCity(t, me, chat, args[0] as Feat, args[1]);
    return;
  }

  if (kind === "p") {
    const [feat, code, pc] = args;
    if (pc === "x") {
      await setAwaiting(me, `custom|${feat}|${code}`);
      await t.send(chat, "Напишите период, например: <code>01.10-15.10</code> (или одну дату <code>15.10</code>). Отмена: /cancel");
      return;
    }
    const p = periodFromCode(pc, today);
    if (!p) return;
    await runFeature(t, me, chat, feat as Feat, code, p);
    return;
  }

  // «Посмотреть все категории»
  if (kind === "ca") {
    const [feat, cc, pc] = args;
    const city = cityFromCode(cc);
    const p = periodFromCode(pc, today);
    if (!city || !p || !citiesOf(me.role).includes(city)) return;
    await sendCategories(t, chat, city, p, feat === "on" ? "online" : "all", true);
    return;
  }

  // «Посмотреть товары» → выбор категорий
  if (kind === "g") {
    const [feat, cc, pc] = args;
    const city = cityFromCode(cc);
    const p = periodFromCode(pc, today);
    if (!city || !p || !citiesOf(me.role).includes(city)) return;
    await startPick(t, me, chat, feat === "on" ? "on" : "cs", city, p);
    return;
  }

  if (kind === "k") {
    const pick = (me.state as { pick?: PickState } | null)?.pick;
    if (!pick) {
      await t.send(chat, "Выбор устарел — нажмите «Посмотреть товары» ещё раз.");
      return;
    }
    if (args[0] === "t") pick.sel[Number(args[1])] = !pick.sel[Number(args[1])];
    else if (args[0] === "a") {
      const all = pick.sel.every(Boolean);
      pick.sel = pick.sel.map(() => !all);
    } else if (args[0] === "go") {
      const cats = pick.cats.filter((_, i) => pick.sel[i]);
      if (cats.length === 0) {
        await t.send(chat, "Отметьте хотя бы одну категорию.");
        return;
      }
      const p = { from: pick.from, to: pick.to };
      const products = pick.feat === "on" ? await onlineProducts(p, cats) : await categoryProducts(pick.city, p, cats);
      await sendLong(t, chat, productsMessage(pick.city, p, pick.feat === "on" ? "online" : "all", products));
      return;
    }
    await supabaseAdmin.from("smm_users").update({ state: { pick } }).eq("id", me.id);
    if (messageId) await t.edit(chat, messageId, PICK_TEXT, pickKeyboard(pick));
    return;
  }

  if (kind === "pl") {
    const city = cityFromCode(args[0]);
    const p = periodFromCode(args[1], today);
    if (!city || !p || !citiesOf(me.role).includes(city)) return;
    await t.send(chat, "⏳ Собираю список…");
    try {
      const { posts } = await listPosts(city, p);
      await sendLong(t, chat, allPostsText(city, p, posts));
    } catch (e) {
      await t.send(chat, `⚠️ Не получилось: ${escapeHtml(getErrorMessage(e))}`);
    }
    return;
  }

  if (kind === "sl") {
    const city = cityFromCode(args[0]);
    const p = periodFromCode(args[1], today);
    if (!city || !p || !citiesOf(me.role).includes(city)) return;
    try {
      await sendLong(t, chat, await storiesList(city, p));
    } catch (e) {
      await t.send(chat, `⚠️ Не получилось: ${escapeHtml(getErrorMessage(e))}`);
    }
  }
}
