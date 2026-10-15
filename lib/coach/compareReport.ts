// Кнопка «Отчёт» в боте-помощнике (владельцы и администраторы городов): PDF «Сравнение периодов» — такой же, как недельный отчёт
// (два периода по дням, итоги и разница второго периода от первого), только периоды выбирает сам руководитель:
// готовые пары (прошлая неделя к позапрошлой, этот месяц к прошлому, прошлый месяц к позапрошлому) или два своих периода.
// Нажатия кнопок — cmp:…; ввод своих дат — через coach_users.awaiting (cmp1:<город> → cmp2:<город>:<с>:<по>).
import { sendCoachDocument, type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { addDays, daysBetween, monthStartOf, mondayOf, todayInAlmaty } from "@/lib/coach/metrics";
import { ALL_STORES, parsePeriodInput, setAwaiting } from "@/lib/coach/salesview";
import { buildWeeklyComparePdf, loadPeriodsCompare, type CompareLabels } from "@/lib/reports/weeklyCompare";

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
    await sendPresetMenu(t, chatId, cities[0], false);
    return;
  }
  await t.send(chatId, "📑 <b>Отчёт · сравнение периодов</b>\nВыберите город:", {
    inline_keyboard: cities.map((c) => [{ text: CITY[c] ?? c, callback_data: `cmp:c:${c}` }]),
  });
}

async function sendPresetMenu(t: Transport, chatId: number | string, store: string, canGoBack: boolean) {
  const rows: { text: string; callback_data: string }[][] = [
    [{ text: "Прошлая неделя ↔ позапрошлая", callback_data: `cmp:p:${store}:w` }],
    [{ text: "Этот месяц ↔ прошлый (по то же число)", callback_data: `cmp:p:${store}:m` }],
    [{ text: "Прошлый месяц ↔ позапрошлый", callback_data: `cmp:p:${store}:pm` }],
    [{ text: "✏️ Выбрать периоды самому", callback_data: `cmp:x:${store}` }],
  ];
  if (canGoBack) rows.push([{ text: "← Города", callback_data: "cmp:m" }]);
  await t.send(
    chatId,
    `📑 <b>Отчёт · сравнение периодов · ${CITY[store] ?? store}</b>\nPDF как недельный отчёт: два периода по дням, итоги и разница. Выберите, что с чем сравнить:`,
    { inline_keyboard: rows }
  );
}

// Готовые пары: [с какого (база), на какой (его разницу показываем)].
function presetRanges(code: string): { p1: Range; p2: Range } | string {
  const today = todayInAlmaty();
  const yesterday = addDays(today, -1);
  if (code === "w") {
    const lastMonday = mondayOf(today);
    return { p1: { from: addDays(lastMonday, -14), to: addDays(lastMonday, -8) }, p2: { from: addDays(lastMonday, -7), to: addDays(lastMonday, -1) } };
  }
  if (code === "m") {
    const start = monthStartOf(today);
    if (start > yesterday) return "С начала месяца данных ещё нет — завтра появятся данные за первый день.";
    const days = daysBetween(start, yesterday) + 1;
    const [y, m] = start.split("-").map(Number);
    const prevStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const prevLast = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const prevEnd = addDays(prevStart, days - 1);
    return { p1: { from: prevStart, to: prevEnd > prevLast ? prevLast : prevEnd }, p2: { from: start, to: yesterday } };
  }
  if (code === "pm") {
    const [y, m] = monthStartOf(today).split("-").map(Number);
    const mk = (offset: number): Range => ({
      from: new Date(Date.UTC(y, m - 1 - offset, 1)).toISOString().slice(0, 10),
      to: new Date(Date.UTC(y, m - offset, 0)).toISOString().slice(0, 10),
    });
    return { p1: mk(2), p2: mk(1) };
  }
  return "Неизвестный вариант.";
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
  await sendCoachDocument(chatId, `Сравнение_периодов_${city}_${p2.to}.pdf`, pdf, `Сравнение периодов · ${city}: ${range(p1)} и ${range(p2)}`);
}

// Нажатия cmp:… ; stores — города, доступные этому администратору.
export async function handleCompareCallback(data: string, t: Transport, chatId: number | string, stores: string[], userId: number) {
  // cmp:m | cmp:c:<город> | cmp:p:<город>:<w|m|pm> | cmp:x:<город>
  const [, kind, store, code] = data.split(":");
  await setAwaiting(userId, null);
  if (kind === "m") {
    await sendCompareStart(t, chatId, stores);
    return;
  }
  if (!storeOk(store, stores)) return;
  if (kind === "c") {
    await sendPresetMenu(t, chatId, store, stores.length > 1);
    return;
  }
  if (kind === "x") {
    await setAwaiting(userId, `cmp1:${store}`);
    await t.send(
      chatId,
      `✏️ <b>Свои периоды · ${CITY[store] ?? store}</b>\nШаг 1 из 2. Напишите период, <b>с которого</b> сравниваем (база):\n• <b>01.09-14.09</b> — с какого по какое\n• <b>12.10</b> — один день\nГод можно не указывать. Данные есть по вчерашний день.`,
      { inline_keyboard: [[{ text: "Отмена", callback_data: `cmp:c:${store}` }]] }
    );
    return;
  }
  if (kind === "p" && code) {
    const r = presetRanges(code);
    if (typeof r === "string") {
      await t.send(chatId, r);
      return;
    }
    await sendPdf(t, chatId, store, r.p1, r.p2);
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
    await setAwaiting(user.id, `cmp2:${store}:${range.from}:${range.to}`);
    await t.send(
      chat,
      `Период 1: <b>${rangeText(range)}</b>\nШаг 2 из 2. Напишите период, <b>на который</b> показать разницу (с чем сравниваем):\n• <b>15.09-28.09</b> или один день <b>13.10</b>`,
      cancel
    );
    return;
  }
  if (step === "cmp2" && from1 && to1) {
    await setAwaiting(user.id, null);
    await sendPdf(t, chat, store, { from: from1, to: to1 }, range);
    return;
  }
  await setAwaiting(user.id, null);
}
