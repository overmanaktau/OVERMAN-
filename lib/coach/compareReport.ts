// Кнопка «Отчёт» в боте-помощнике (владельцы и администраторы городов): PDF «Сравнение периодов» — такой же, как недельный отчёт
// (два периода по дням, итоги и разница второго периода от первого), только периоды выбирает сам руководитель: каждый — кнопкой
// (вчера, прошлая неделя, с начала месяца …) или своим вводом (01.09-14.09). Шаг 1 — с какого периода сравниваем (база), шаг 2 — на какой
// период показать разницу. Нажатия кнопок — cmp:…; ввод своих дат — через coach_users.awaiting (cmp1:<город> → cmp2:<город>:<с>:<по>).
import { sendCoachDocument, type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { addDays, daysBetween, monthStartOf, mondayOf, todayInAlmaty } from "@/lib/coach/metrics";
import { ALL_STORES, parsePeriodInput, setAwaiting } from "@/lib/coach/salesview";
import { buildWeeklyComparePdf, loadPeriodsCompare, type CompareLabels } from "@/lib/reports/weeklyCompare";
import { ruDay } from "@/lib/fileNames";

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const MAX_DAYS = 92; // период длиннее — таблица по дням не поместится в разумный файл
type Range = { from: string; to: string };

const fmtFull = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const fmtShort = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const rangeText = (r: Range) => (r.from === r.to ? fmtFull(r.from) : `${fmtFull(r.from)} – ${fmtFull(r.to)}`);

function storeOk(store: string | undefined, stores: string[]): store is string {
  return !!store && ALL_STORES.includes(store) && stores.includes(store);
}

// Старт: владельцу — выбор города, администратору города — сразу выбор периодов своего города.
export async function sendCompareStart(t: Transport, chatId: number | string, stores: string[]) {
  const cities = stores.filter((s) => ALL_STORES.includes(s));
  if (cities.length === 0) return;
  if (cities.length === 1) {
    await sendStep1(t, chatId, cities[0], false);
    return;
  }
  await t.send(chatId, "📑 <b>Отчёт · сравнение периодов</b>\nВыберите город:", {
    inline_keyboard: cities.map((c) => [{ text: CITY[c] ?? c, callback_data: `cmp:c:${c}` }]),
  });
}

// Периоды-кнопки. Данные есть по вчерашний день, поэтому «Эта неделя» и «С начала месяца» — по вчера.
const PERIOD_BUTTONS: { code: string; label: string }[] = [
  { code: "y", label: "Вчера" },
  { code: "yy", label: "Позавчера" },
  { code: "w", label: "Прошлая неделя" },
  { code: "ww", label: "Позапрошлая неделя" },
  { code: "tw", label: "Эта неделя" },
  { code: "m", label: "С начала месяца" },
  { code: "pm", label: "Прошлый месяц" },
  { code: "ppm", label: "Позапрошлый месяц" },
];

function periodByCode(code: string): Range | string {
  const today = todayInAlmaty();
  const yesterday = addDays(today, -1);
  const thisMonday = mondayOf(today);
  const [y, m] = monthStartOf(today).split("-").map(Number);
  const monthRange = (offset: number): Range => ({
    from: new Date(Date.UTC(y, m - 1 - offset, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m - offset, 0)).toISOString().slice(0, 10),
  });
  switch (code) {
    case "y":
      return { from: yesterday, to: yesterday };
    case "yy":
      return { from: addDays(today, -2), to: addDays(today, -2) };
    case "w":
      return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
    case "ww":
      return { from: addDays(thisMonday, -14), to: addDays(thisMonday, -8) };
    case "tw":
      return thisMonday > yesterday ? "Эта неделя только началась — данных ещё нет (они появятся завтра)." : { from: thisMonday, to: yesterday };
    case "m": {
      const start = monthStartOf(today);
      return start > yesterday ? "Месяц только начался — данных ещё нет (они появятся завтра)." : { from: start, to: yesterday };
    }
    case "pm":
      return monthRange(1);
    case "ppm":
      return monthRange(2);
    default:
      return "Неизвестный период.";
  }
}

// Кнопки периодов (по две в ряд) и «Свой период». prefix — как начинаются callback_data выбора («cmp:a:<город>» или «cmp:b:<город>:<с>:<по>»).
function periodKeyboard(prefix: string, customData: string, back?: { text: string; data: string }): ReplyMarkup {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < PERIOD_BUTTONS.length; i += 2) {
    rows.push(PERIOD_BUTTONS.slice(i, i + 2).map((b) => ({ text: b.label, callback_data: `${prefix}:${b.code}` })));
  }
  rows.push([{ text: "✏️ Свой период", callback_data: customData }]);
  if (back) rows.push([{ text: back.text, callback_data: back.data }]);
  return { inline_keyboard: rows };
}

// Шаг 1: с какого периода сравниваем.
async function sendStep1(t: Transport, chatId: number | string, store: string, canGoBack: boolean) {
  await t.send(
    chatId,
    `📑 <b>Отчёт · сравнение периодов · ${CITY[store] ?? store}</b>
PDF как недельный отчёт: два периода по дням, итоги и разница.

Шаг 1 из 2. <b>С какого периода</b> сравниваем (база)?`,
    periodKeyboard(`cmp:a:${store}`, `cmp:ax:${store}`, canGoBack ? { text: "← Города", data: "cmp:m" } : undefined)
  );
}

// Шаг 2: на какой период показать разницу (период 1 уже выбран).
async function sendStep2(t: Transport, chatId: number | string, store: string, p1: Range) {
  await t.send(
    chatId,
    `Период 1: <b>${rangeText(p1)}</b>
Шаг 2 из 2. <b>На какой период</b> показать разницу?`,
    periodKeyboard(`cmp:b:${store}:${p1.from}:${p1.to}`, `cmp:bx:${store}:${p1.from}:${p1.to}`, { text: "← Выбрать период 1 заново", data: `cmp:c:${store}` })
  );
}

// PDF «Сравнение периодов» для города: период 1 — база, период 2 — тот, чью разницу показываем.
export async function buildPeriodsComparePdf(store: string, p1: Range, p2: Range): Promise<{ pdf: Uint8Array; city: string }> {
  const { weeks, city } = await loadPeriodsCompare(store, p1, p2);
  const labels: CompareLabels = {
    title: `Сравнение периодов · ${city}`,
    subtitle: `${rangeText(p1)}   ·   ${rangeText(p2)}`,
    bands: [`Период 1 · ${rangeText(p1)}`, `Период 2 · ${rangeText(p2)}`],
    diff: "разница периода 2 от 1",
    dayAsDate: true,
  };
  return { pdf: await buildWeeklyComparePdf(weeks, city, labels), city };
}

async function sendPdf(t: Transport, chatId: number | string, store: string, p1: Range, p2: Range) {
  await t.send(chatId, "⏳ Готовлю отчёт…");
  const { pdf, city } = await buildPeriodsComparePdf(store, p1, p2);
  const range = (r: Range) => (r.from === r.to ? fmtShort(r.from) : `${fmtShort(r.from)}–${fmtShort(r.to)}`);
  await sendCoachDocument(chatId, `Сравнение периодов ${city} ${ruDay(p2.to)}.pdf`, pdf, `Сравнение периодов · ${city}: ${range(p1)} и ${range(p2)}`);
}

// Нажатия cmp:… ; stores — города, доступные этому администратору.
export async function handleCompareCallback(data: string, t: Transport, chatId: number | string, stores: string[], userId: number) {
  // cmp:m | cmp:c:<город> | cmp:a:<город>:<код> | cmp:ax:<город> | cmp:b:<город>:<с>:<по>:<код> | cmp:bx:<город>:<с>:<по>
  const [, kind, store, x1, x2, x3] = data.split(":");
  await setAwaiting(userId, null);
  if (kind === "m") {
    await sendCompareStart(t, chatId, stores);
    return;
  }
  if (!storeOk(store, stores)) return;
  if (kind === "c") {
    await sendStep1(t, chatId, store, stores.length > 1);
    return;
  }
  const cancel: ReplyMarkup = { inline_keyboard: [[{ text: "Отмена", callback_data: `cmp:c:${store}` }]] };
  const ask = () =>
    `Напишите период:
• <b>01.09-14.09</b> — с какого по какое
• <b>12.10</b> — один день
Год можно не указывать. Данные есть по вчерашний день.`;
  if (kind === "ax") {
    await setAwaiting(userId, `cmp1:${store}`);
    await t.send(chatId, `✏️ <b>Свой период 1 · ${CITY[store] ?? store}</b>
Шаг 1 из 2. С какого периода сравниваем (база).
${ask()}`, cancel);
    return;
  }
  if (kind === "a" && x1) {
    const r = periodByCode(x1);
    if (typeof r === "string") {
      await t.send(chatId, r);
      return;
    }
    await sendStep2(t, chatId, store, r);
    return;
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((kind === "b" || kind === "bx") && dateRe.test(x1 ?? "") && dateRe.test(x2 ?? "")) {
    const p1: Range = { from: x1, to: x2 };
    if (kind === "bx") {
      await setAwaiting(userId, `cmp2:${store}:${p1.from}:${p1.to}`);
      await t.send(chatId, `✏️ <b>Свой период 2 · ${CITY[store] ?? store}</b>
Период 1: <b>${rangeText(p1)}</b>
Шаг 2 из 2. На какой период показать разницу.
${ask()}`, cancel);
      return;
    }
    const r = periodByCode(x3 ?? "");
    if (typeof r === "string") {
      await t.send(chatId, r);
      return;
    }
    await sendPdf(t, chatId, store, p1, r);
  }
}

// Текст администратора, пока бот ждёт период (cmp1 / cmp2).
export async function handleCompareInput(t: Transport, user: { id: number; telegram_chat_id: number }, awaiting: string, text: string, stores: string[]) {
  const [step, store, from1, to1] = awaiting.split(":");
  const chat = user.telegram_chat_id;
  if (!storeOk(store, stores)) {
    await setAwaiting(user.id, null);
    return;
  }
  const today = todayInAlmaty();
  const yesterday = addDays(today, -1);
  const cancel: ReplyMarkup = { inline_keyboard: [[{ text: "Отмена", callback_data: `cmp:c:${store}` }]] };
  const range = parsePeriodInput(text, today);
  if (!range) {
    await t.send(chat, "Не разобрал даты. Напишите так: <b>01.09-14.09</b> (с какого по какое) или одну дату <b>12.10</b>. Год можно не указывать.", cancel);
    return;
  }
  if (range.from > range.to) {
    await t.send(chat, "Начало периода позже конца. Напишите ещё раз, например <b>01.09-14.09</b>.", cancel);
    return;
  }
  if (range.to > yesterday) {
    await t.send(chat, `Данные есть по вчерашний день (${fmtFull(yesterday)}). Напишите период, который заканчивается не позже.`, cancel);
    return;
  }
  if (daysBetween(range.from, range.to) + 1 > MAX_DAYS) {
    await t.send(chat, `Период слишком длинный — не больше ${MAX_DAYS} дней. Напишите ещё раз.`, cancel);
    return;
  }
  if (step === "cmp1") {
    await setAwaiting(user.id, null);
    await sendStep2(t, chat, store, range);
    return;
  }
  if (step === "cmp2" && from1 && to1) {
    await setAwaiting(user.id, null);
    await sendPdf(t, chat, store, { from: from1, to: to1 }, range);
    return;
  }
  await setAwaiting(user.id, null);
}
