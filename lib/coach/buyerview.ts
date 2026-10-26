// Бот-помощник для закупщика: кнопки «Отчёт», «ABC/XYZ», «Проданные товары». Шаги: город (Актау / Актобе / Все города) → период (как в «Продажах»
// у администратора, плюс свой период) → для ABC/XYZ и «Проданных товаров» ещё поставщики галочками (по умолчанию все) → один PDF-файл.
// Только два основных склада (lib/reports/buyerStores.ts). Данные по товарам загружаются ночью, поэтому «Сегодня» нет, а период без данных в меню не показывается.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { getErrorMessage } from "@/lib/errors";
import type { ReplyMarkup, Transport } from "@/lib/coach/bot";
import { BUYER_MENU_MARKUP } from "@/lib/coach/bot";
import { parsePeriodInput, setAwaiting } from "@/lib/coach/salesview";
import { addDays, daysBetween, todayInAlmaty } from "@/lib/coach/metrics";
import { BUYER_CITY_TITLE, BUYER_STORES } from "@/lib/reports/buyerStores";
import { BUYER_PERIOD_LABEL, BUYER_PERIOD_ORDER, previousPeriod, resolvePeriod, type BuyerPeriod, type DateRange } from "@/lib/reports/buyerPeriods";
import { buildWarehouseOverviewPdf, loadWarehouseWeek, warehouseFileName } from "@/lib/reports/warehouseOverview";
import { buildAbcPdfFor, buildSoldPdfFor, buyerFileName } from "@/lib/reports/buyerPdf";

type Kind = "r" | "a" | "p";
const KIND_TITLE: Record<Kind, string> = { r: "Отчёт", a: "ABC/XYZ", p: "Проданные товары" };
const CITY_OF: Record<string, string> = { "1": "point_1", "3": "point_3", a: "all" };
const MAX_CUSTOM_DAYS = 366;

// Текст кнопки меню → вид отчёта.
const KIND_BY_TEXT: Record<string, Kind> = {
  отчёт: "r",
  отчет: "r",
  "/report": "r",
  "abc/xyz": "a",
  "авс/xyz": "a",
  "abc xyz": "a",
  "проданные товары": "p",
};
export const buyerKindOf = (text: string): Kind | null => KIND_BY_TEXT[text.trim().toLowerCase()] ?? null;

const ru = (d: string) => d.split("-").reverse().join(".");
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

async function sendCityMenu(t: Transport, chatId: number, k: Kind) {
  const markup: ReplyMarkup = {
    inline_keyboard: [
      [
        { text: "Актау", callback_data: `by:c:${k}:1` },
        { text: "Актобе", callback_data: `by:c:${k}:3` },
      ],
      [{ text: "Все города", callback_data: `by:c:${k}:a` }],
    ],
  };
  await t.send(chatId, `<b>${KIND_TITLE[k]}</b>\nВыберите город:`, markup);
}

async function sendPeriodMenu(t: Transport, chatId: number, k: Kind, c: string, note?: string) {
  // Только периоды, по которым уже есть данные (в понедельник нет «Эта неделя», 1-го числа — «Этот месяц»).
  const today = todayInAlmaty();
  const periods = BUYER_PERIOD_ORDER.filter((p) => resolvePeriod(p, today).from <= addDays(today, -1));
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < periods.length; i += 2) {
    rows.push(periods.slice(i, i + 2).map((p) => ({ text: BUYER_PERIOD_LABEL[p], callback_data: `by:p:${k}:${c}:${p}` })));
  }
  rows.push([{ text: "✏️ Свой период", callback_data: `by:p:${k}:${c}:c` }]);
  rows.push([{ text: "← Назад", callback_data: `by:k:${k}` }]);
  await t.send(chatId, `${note ? `${note}\n\n` : ""}<b>${KIND_TITLE[k]} · ${BUYER_CITY_TITLE[CITY_OF[c]]}</b>\nВыберите период:`, { inline_keyboard: rows });
}

type State = { kind: Kind; city: string; from: string; to: string; title: string; suppliers: string[]; off: number[] };

async function loadState(userId: number): Promise<State | null> {
  const { data, error } = await supabaseAdmin.from("coach_buyer_state").select("kind, city, from_date, to_date, title, suppliers, off").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data || !data.from_date || !data.to_date || !data.city) return null;
  return { kind: data.kind as Kind, city: data.city, from: data.from_date, to: data.to_date, title: data.title ?? "Период", suppliers: (data.suppliers ?? []) as string[], off: (data.off ?? []) as number[] };
}

async function saveState(userId: number, s: State) {
  const { error } = await supabaseAdmin
    .from("coach_buyer_state")
    .upsert({ user_id: userId, kind: s.kind, city: s.city, from_date: s.from, to_date: s.to, title: s.title, suppliers: s.suppliers, off: s.off, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw error;
}

function supplierMarkup(s: State): ReplyMarkup {
  const off = new Set(s.off);
  return {
    inline_keyboard: [
      ...s.suppliers.map((name, i) => [{ text: `${off.has(i) ? "⬜" : "✅"} ${name}`, callback_data: `by:s:t:${i}` }]),
      [
        { text: "✅ Отметить все", callback_data: "by:s:a" },
        { text: "⬜ Снять все", callback_data: "by:s:n" },
      ],
      [{ text: "Сформировать PDF", callback_data: "by:s:g" }],
    ],
  };
}

async function sendSupplierMenu(t: Transport, chatId: number, s: State) {
  await t.send(
    chatId,
    `<b>${KIND_TITLE[s.kind]} · ${BUYER_CITY_TITLE[s.city]}</b>\n${escapeHtml(s.title)}: ${ru(s.from)} — ${ru(s.to)}\n\nКакие поставщики нужны? Нажмите на поставщика, чтобы снять или поставить галочку. По умолчанию отмечены все. Когда выберете — «Сформировать PDF».`,
    supplierMarkup(s)
  );
}

// Кнопка или период выбраны: «Отчёт» сразу собираем в PDF, у ABC/XYZ и «Проданных товаров» сначала спрашиваем поставщиков.
async function proceed(t: Transport, user: { id: number; telegram_chat_id: number }, k: Kind, c: string, perKey: BuyerPeriod, custom?: DateRange) {
  const chatId = user.telegram_chat_id;
  const today = todayInAlmaty();
  const range = resolvePeriod(perKey, today, custom);
  if (range.from > addDays(today, -1)) {
    await sendPeriodMenu(t, chatId, k, c, "За этот период данных ещё нет — они появятся утром следующего дня. Выберите другой период.");
    return;
  }
  const cityKey = CITY_OF[c];
  const title = perKey === "c" ? "Свой период" : BUYER_PERIOD_LABEL[perKey];

  if (k === "r") {
    await t.send(chatId, "Готовлю PDF…");
    const prev = previousPeriod(perKey, range, today);
    const [cur, before] = await Promise.all([loadWarehouseWeek(cityKey, range.from, range.to, true), loadWarehouseWeek(cityKey, prev.from, prev.to, false)]);
    const pdf = await buildWarehouseOverviewPdf(cityKey, before, cur, "custom", title);
    await t.sendDocument(chatId, warehouseFileName(BUYER_CITY_TITLE[cityKey], range), pdf, `Склад — обзор · ${BUYER_CITY_TITLE[cityKey]}: ${dm(range.from)}–${dm(range.to)} к ${dm(prev.from)}–${dm(prev.to)}`);
    return;
  }

  const { data, error } = await supabaseAdmin.rpc("buyer_suppliers", { p_stores: BUYER_STORES[cityKey], p_from: range.from, p_to: range.to });
  if (error) throw error;
  const suppliers = ((data ?? []) as { supplier_name: string }[]).map((r) => r.supplier_name);
  if (suppliers.length === 0) {
    await sendPeriodMenu(t, chatId, k, c, "За этот период продаж нет. Выберите другой период.");
    return;
  }
  const state: State = { kind: k, city: cityKey, from: range.from, to: range.to, title, suppliers, off: [] };
  await saveState(user.id, state);
  await sendSupplierMenu(t, chatId, state);
}

async function generate(t: Transport, chatId: number, s: State, chosen: string[]) {
  const suppliers = chosen.length === s.suppliers.length ? null : chosen;
  await t.send(chatId, "Готовлю PDF…");
  const bytes = s.kind === "a" ? await buildAbcPdfFor(s.city, s.from, s.to, suppliers, s.suppliers.length, s.title) : await buildSoldPdfFor(s.city, s.from, s.to, suppliers, s.suppliers.length, s.title);
  const supNote = suppliers === null ? "все поставщики" : `поставщиков: ${suppliers.length} из ${s.suppliers.length}`;
  await t.sendDocument(chatId, buyerFileName(s.kind === "a" ? "abc" : "sold", s.city, s.from, s.to), bytes, `${KIND_TITLE[s.kind]} · ${BUYER_CITY_TITLE[s.city]}: ${dm(s.from)}–${dm(s.to)} · ${supNote}`);
}

type BuyerUser = { id: number; telegram_chat_id: number; employee_name: string; awaiting: string | null };

// Нажатие кнопки у закупщика (callback_data «by:…»).
export async function handleBuyerCallback(data: string, t: Transport, user: BuyerUser, messageId: number | undefined, dropCurrent: () => Promise<void>): Promise<void> {
  const chatId = user.telegram_chat_id;
  const parts = data.split(":");
  try {
    if (parts[1] === "k") {
      await dropCurrent();
      await setAwaiting(user.id, null);
      await sendCityMenu(t, chatId, parts[2] as Kind);
      return;
    }
    if (parts[1] === "c" && CITY_OF[parts[3]]) {
      await dropCurrent();
      await setAwaiting(user.id, null);
      await sendPeriodMenu(t, chatId, parts[2] as Kind, parts[3]);
      return;
    }
    if (parts[1] === "p" && CITY_OF[parts[3]]) {
      await dropCurrent();
      const k = parts[2] as Kind;
      const per = parts[4] as BuyerPeriod;
      if (per === "c") {
        await setAwaiting(user.id, `buy:${k}:${parts[3]}`);
        await t.send(chatId, "Напишите период так: <b>01.10-15.10</b> (с какого по какое) или одну дату <b>05.10</b>. Год можно не указывать.", { inline_keyboard: [[{ text: "Отмена", callback_data: `by:c:${k}:${parts[3]}` }]] });
        return;
      }
      await setAwaiting(user.id, null);
      await proceed(t, user, k, parts[3], per);
      return;
    }
    if (parts[1] === "s") {
      const s = await loadState(user.id);
      if (!s) {
        await t.send(chatId, "Выбор устарел. Нажмите нужную кнопку внизу ещё раз.", BUYER_MENU_MARKUP);
        return;
      }
      const action = parts[2];
      if (action === "g") {
        const off = new Set(s.off);
        const chosen = s.suppliers.filter((_, i) => !off.has(i));
        if (chosen.length === 0) {
          await t.send(chatId, "Отметьте хотя бы одного поставщика.");
          return;
        }
        await dropCurrent();
        await generate(t, chatId, s, chosen);
        return;
      }
      if (action === "t") {
        const i = Number(parts[3]);
        if (!Number.isInteger(i) || i < 0 || i >= s.suppliers.length) return;
        s.off = s.off.includes(i) ? s.off.filter((x) => x !== i) : [...s.off, i];
      } else if (action === "a") s.off = [];
      else if (action === "n") s.off = s.suppliers.map((_, i) => i);
      else return;
      await saveState(user.id, s);
      if (messageId !== undefined) await t.editButtons(chatId, messageId, supplierMarkup(s)).catch(() => null);
    }
  } catch (e) {
    console.error("buyer callback error:", getErrorMessage(e));
    await t.send(chatId, "Не удалось подготовить отчёт. Попробуйте ещё раз чуть позже.");
  }
}

// Сообщение закупщика: кнопка меню, свой период или любой другой текст.
export async function handleBuyerText(t: Transport, user: BuyerUser, text: string): Promise<void> {
  const chatId = user.telegram_chat_id;
  const kind = buyerKindOf(text);
  try {
    if (kind) {
      await setAwaiting(user.id, null);
      await sendCityMenu(t, chatId, kind);
      return;
    }
    if (user.awaiting?.startsWith("buy:")) {
      const [, k, c] = user.awaiting.split(":");
      const retry: ReplyMarkup = { inline_keyboard: [[{ text: "Отмена", callback_data: `by:c:${k}:${c}` }]] };
      const range = parsePeriodInput(text, todayInAlmaty());
      if (!range) {
        await t.send(chatId, "Не разобрал даты. Напишите так: <b>01.10-15.10</b> (с какого по какое) или одну дату <b>05.10</b>. Год можно не указывать.", retry);
        return;
      }
      if (range.from > range.to) {
        await t.send(chatId, "Начало периода позже конца. Напишите ещё раз, например <b>01.10-15.10</b>.", retry);
        return;
      }
      if (daysBetween(range.from, range.to) + 1 > MAX_CUSTOM_DAYS) {
        await t.send(chatId, `Период слишком длинный — не больше ${MAX_CUSTOM_DAYS} дней. Напишите ещё раз.`, retry);
        return;
      }
      await setAwaiting(user.id, null);
      await proceed(t, user, k as Kind, c, "c", range);
      return;
    }
    await t.send(
      chatId,
      text === "/start"
        ? `Здравствуйте, ${escapeHtml(user.employee_name)}! Выберите отчёт кнопкой внизу: «Отчёт», «ABC/XYZ» или «Проданные товары». Каждый понедельник в 7:00 и 1-го числа каждого месяца я сам присылаю склад-обзор по Актау и по Актобе.`
        : "Выберите отчёт кнопкой внизу: «Отчёт», «ABC/XYZ» или «Проданные товары».",
      BUYER_MENU_MARKUP
    );
  } catch (e) {
    console.error("buyer text error:", getErrorMessage(e));
    await t.send(chatId, "Не удалось подготовить отчёт. Попробуйте ещё раз чуть позже.");
  }
}
