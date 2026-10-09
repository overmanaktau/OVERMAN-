// Раздел «Продажи» для администратора бота: продажи стилистов-консультантов по
// выбранному городу за вчера / последние 7 дней / месяц. Администратор видит
// только свои города (admin_scope: 'city' — свой, 'all' — все).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { SCOPES, buildCashReport, money, num, pre, shortName } from "@/lib/reports/sales";
import { type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { addDays, daysBetween, monthStartOf, shortDate, todayInAlmaty } from "@/lib/coach/metrics";

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const HIDDEN_NAME = /саяпарк|saya/i;
type Period = "y" | "w" | "m" | "c"; // c — свой период (даты вводятся текстом)
const PERIOD_LABEL: Record<Period, string> = { y: "Вчера", w: "Последние 7 дней", m: "Месяц", c: "Свой период" };
type Range = { from: string; to: string };
const MAX_CUSTOM_DAYS = 366;
const CASH_MAX_DAYS = 31; // касса города (оплаты и возвраты тянутся из МойСклад — дольше не успевает)
const CASH_MAX_DAYS_ALL = 20; // касса по всем городам (два города подряд)

export const ALL_STORES = Object.keys(CITY);

// Что показывать: продажи по сотрудникам (e) или общая касса города (k).
type Mode = "e" | "k";
const MODE_LABEL: Record<Mode, string> = { e: "по сотрудникам", k: "по городу (общая касса)" };

// Вход в раздел: сначала выбор — по сотрудникам или по городу (общая касса).
export async function sendSalesStart(t: Transport, chatId: number | string, _stores?: string[]) {
  await t.send(chatId, "📊 <b>Продажи</b>\nЧто показать?", {
    inline_keyboard: [
      [{ text: "👥 По сотрудникам", callback_data: "adm:s:m:e" }],
      [{ text: "🏙 По городу (общая касса)", callback_data: "adm:s:m:k" }],
    ],
  });
}

// Дальше выбор города (если их несколько), иначе сразу период.
async function sendCityMenu(t: Transport, chatId: number | string, mode: Mode, stores: string[]) {
  if (stores.length === 1) {
    await sendPeriodMenu(t, chatId, mode, stores[0], false);
    return;
  }
  await t.send(chatId, `📊 <b>Продажи ${MODE_LABEL[mode]}</b>\nВыберите город:`, {
    inline_keyboard: [
      ...stores.map((s) => [{ text: CITY[s] ?? s, callback_data: `adm:s:c:${mode}:${s}` }]),
      [{ text: "Все города", callback_data: `adm:s:c:${mode}:all` }],
      [{ text: "← Назад", callback_data: "adm:s" }],
    ],
  });
}

async function sendPeriodMenu(t: Transport, chatId: number | string, mode: Mode, store: string, canGoBack: boolean) {
  const rows: { text: string; callback_data: string }[][] = (["y", "w", "m"] as Period[]).map((p) => [
    { text: PERIOD_LABEL[p], callback_data: `adm:s:p:${mode}:${store}:${p}` },
  ]);
  rows.push([{ text: "✏️ Свой период", callback_data: `adm:s:x:${mode}:${store}` }]);
  // Назад: к выбору города (если городов несколько) или к выбору «по сотрудникам / по городу».
  rows.push([{ text: "← Назад", callback_data: canGoBack ? `adm:s:m:${mode}` : "adm:s" }]);
  await t.send(
    chatId,
    `📊 <b>Продажи ${MODE_LABEL[mode]} · ${store === "all" ? "Все города" : (CITY[store] ?? store)}</b>\nЗа какой период?`,
    { inline_keyboard: rows }
  );
}

function rangeFor(period: Period, custom?: Range): Range {
  const today = todayInAlmaty();
  const yesterday = addDays(today, -1);
  if (period === "c" && custom) {
    // Данные есть по вчера: будущие даты обрезаем.
    return { from: custom.from, to: custom.to > yesterday ? yesterday : custom.to };
  }
  if (period === "y") return { from: yesterday, to: yesterday };
  if (period === "w") return { from: addDays(yesterday, -6), to: yesterday };
  return { from: monthStartOf(today), to: yesterday };
}

// ---- Ввод своего периода ----

function toIso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// «05.10», «05.10.26», «05.10.2026» (год по умолчанию — текущий).
function parseDay(s: string, defaultYear: number): string | null {
  const m = s.trim().match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/);
  if (!m) return null;
  const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : defaultYear;
  return toIso(year, Number(m[2]), Number(m[1]));
}

// «01.10-15.10», «01.10 по 15.10», «01.10–15.10.2026» или одна дата.
export function parsePeriodInput(text: string, today: string): Range | null {
  const year = Number(today.slice(0, 4));
  // «по» и «до» между датами — то же, что дефис (в JS \b не работает с кириллицей).
  const parts = text
    .trim()
    .replace(/\s+(?:по|до)\s+/gi, "-")
    .split(/\s*(?:-|–|—)\s*/)
    .filter(Boolean);
  if (parts.length === 1) {
    const d = parseDay(parts[0], year);
    return d ? { from: d, to: d } : null;
  }
  if (parts.length !== 2) return null;
  const from = parseDay(parts[0], year);
  const to = parseDay(parts[1], year);
  return from && to ? { from, to } : null;
}

export async function setAwaiting(userId: number, value: string | null) {
  const { error } = await supabaseAdmin.from("coach_users").update({ awaiting: value }).eq("id", userId);
  if (error) throw error;
}

// Администратор прислал текст, пока бот ждал период. true — текст разобран как ввод.
export async function handleCustomPeriodInput(
  t: Transport,
  user: { id: number; telegram_chat_id: number },
  awaiting: string,
  text: string,
  stores: string[]
): Promise<void> {
  // sales:<режим>:<город>
  const [, modeRaw, store] = awaiting.split(":");
  const mode: Mode = modeRaw === "k" ? "k" : "e";
  if (!store || (store === "all" ? stores.length < 2 : !stores.includes(store))) {
    await setAwaiting(user.id, null);
    return;
  }
  const chat = user.telegram_chat_id;
  const range = parsePeriodInput(text, todayInAlmaty());
  const retry: ReplyMarkup = { inline_keyboard: [[{ text: "Отмена", callback_data: `adm:s:c:${mode}:${store}` }]] };
  if (!range) {
    await t.send(chat, "Не разобрал даты. Напишите так: <b>01.10-15.10</b> (с какого по какое) или одну дату <b>05.10</b>. Год можно не указывать.", retry);
    return;
  }
  if (range.from > range.to) {
    await t.send(chat, "Начало периода позже конца. Напишите ещё раз, например <b>01.10-15.10</b>.", retry);
    return;
  }
  if (daysBetween(range.from, range.to) + 1 > MAX_CUSTOM_DAYS) {
    await t.send(chat, `Период слишком длинный — не больше ${MAX_CUSTOM_DAYS} дней. Напишите ещё раз.`, retry);
    return;
  }
  await setAwaiting(user.id, null);
  await sendReport(t, chat, mode, store, "c", range);
}

// Общая касса города за период (для «Все города» — касса каждого города и общий итог).
async function buildCashMessages(store: string, period: Period, custom?: Range): Promise<string[]> {
  const { from, to } = rangeFor(period, custom);
  if (from > to) return ["📊 <b>Касса</b>\n\nЗа этот период данных ещё нет."];
  const scopes = store === "all" ? [SCOPES.point_1, SCOPES.point_3, SCOPES.all] : [SCOPES[store]];
  // Оплаты, возвраты и LTV тянутся из МойСклад, и на длинном периоде бот не успевает
  // ответить (за 9 месяцев — больше двух минут). Поэтому для длинного периода показываем
  // облегчённую кассу (итоги и трафик — из базы) с пометкой.
  const days = daysBetween(from, to) + 1;
  const heavyLimit = store === "all" ? CASH_MAX_DAYS_ALL : CASH_MAX_DAYS;
  const tooLong = days > heavyLimit;
  // По очереди, не одновременно: МойСклад отвечает 429 на параллельные запросы. Общий итог
  // по всем городам всегда облегчённый — остальное уже показано по каждому городу.
  const messages: string[] = [];
  for (const scope of scopes) messages.push(...(await buildCashReport(scope, from, to, tooLong || scope.key === "all")));
  if (tooLong) {
    messages.push(
      `<i>Период ${days} дн.: показаны итоги и трафик. Оплаты, возвраты и LTV считаются за период до ${heavyLimit} дней${store === "all" ? " (для всех городов)" : ""}.</i>`
    );
  }
  return messages;
}

// Telegram принимает не больше 4096 знаков в сообщении. Длинный отчёт режем по строкам,
// закрывая и заново открывая блок <pre>, если разрез пришёлся внутрь него.
function splitLong(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  let inPre = false;
  for (const line of text.split("\n")) {
    const opens = line.includes("<pre>");
    const closes = line.includes("</pre>");
    if (current.length + line.length + 8 > limit && current) {
      chunks.push(inPre ? `${current}</pre>` : current);
      current = inPre ? "<pre>⠀\n" : "";
    }
    current += (current && !current.endsWith("\n") ? "\n" : "") + line;
    if (opens) inPre = true;
    if (closes) inPre = false;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendReport(t: Transport, chatId: number | string, mode: Mode, store: string, period: Period, custom?: Range) {
  const back: ReplyMarkup = { inline_keyboard: [[{ text: "← Другой период", callback_data: `adm:s:c:${mode}:${store}` }]] };
  let messages: string[];
  try {
    messages = mode === "k" ? await buildCashMessages(store, period, custom) : [await buildReport(store, period, custom)];
  } catch (e) {
    messages = [`Не удалось собрать продажи: ${escapeHtml(e instanceof Error ? e.message : String(e))}`];
  }
  messages = messages.flatMap((m) => splitLong(m));
  // Кнопка возврата — только под последним сообщением отчёта.
  for (let i = 0; i < messages.length; i++) {
    await t.send(chatId, messages[i], i === messages.length - 1 ? back : undefined);
  }
}

// Всё, что показываем по сотруднику (и по городу в итоге): выручка, чеки, товары,
// возвраты, смены — отсюда средний чек, глубина чека и выручка за смену.
type Total = {
  revenue: number;
  receipts: number;
  items: number;
  retAmount: number;
  retReceipts: number;
  retItems: number;
  shifts: number;
};
type Agg = Total & { id: string; name: string };
const EMPTY: Total = { revenue: 0, receipts: 0, items: 0, retAmount: 0, retReceipts: 0, retItems: 0, shifts: 0 };
const avgCheck = (a: Total) => (a.receipts > 0 ? money(a.revenue / a.receipts) : "—");
const depth = (a: Total) => (a.receipts > 0 ? (a.items / a.receipts).toFixed(2) : "—");

// Стилисты одного города за период: список по убыванию выручки и планы месяца.
type SalesRow = {
  employee_ms_id: string;
  employee_name: string;
  sale_date: string;
  revenue: number;
  receipts_count: number;
  items_count: number;
  returned_amount: number | null;
  returned_receipts: number | null;
  returned_items: number | null;
};

// Строки продаж за период постранично: PostgREST отдаёт не больше 1000 за запрос.
async function loadSales(store: string, from: string, to: string): Promise<SalesRow[]> {
  const rows: SalesRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("moysklad_employee_sales_daily")
      .select("employee_ms_id, employee_name, sale_date, revenue, receipts_count, items_count, returned_amount, returned_receipts, returned_items")
      .eq("store", store)
      .gte("sale_date", from)
      .lte("sale_date", to)
      .order("sale_date")
      .order("employee_ms_id")
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as SalesRow[]));
    if (!data || data.length < 1000) return rows;
  }
}

async function cityData(store: string, period: Period, custom?: Range): Promise<{ list: Agg[]; planOf: Map<string, number> }> {
  const { from, to } = rangeFor(period, custom);
  const [salesRows, plans] = await Promise.all([
    loadSales(store, from, to),
    period === "m"
      ? supabaseAdmin.from("sales_plan_monthly").select("employee_ms_id, sales_plan").eq("store", store).eq("plan_month", monthStartOf(to))
      : Promise.resolve({ data: [] as { employee_ms_id: string; sales_plan: number | null }[], error: null }),
  ]);
  if (plans.error) throw plans.error;

  const planOf = new Map<string, number>();
  for (const p of (plans.data ?? []) as { employee_ms_id: string; sales_plan: number | null }[]) {
    if (p.sales_plan !== null) planOf.set(p.employee_ms_id, Number(p.sales_plan));
  }
  const byId = new Map<string, Agg>();
  const shiftDays = new Map<string, Set<string>>(); // смена — день, когда у сотрудника есть выручка или чеки
  for (const r of salesRows) {
    if (HIDDEN_NAME.test(r.employee_name)) continue;
    const a = byId.get(r.employee_ms_id) ?? { ...EMPTY, id: r.employee_ms_id, name: r.employee_name };
    const revenue = Number(r.revenue) || 0;
    const receipts = Number(r.receipts_count) || 0;
    a.revenue += revenue;
    a.receipts += receipts;
    a.items += Number(r.items_count) || 0;
    a.retAmount += Number(r.returned_amount) || 0;
    a.retReceipts += Number(r.returned_receipts) || 0;
    a.retItems += Number(r.returned_items) || 0;
    byId.set(r.employee_ms_id, a);
    if (receipts > 0 || revenue > 0) {
      const days = shiftDays.get(r.employee_ms_id) ?? new Set<string>();
      days.add(r.sale_date);
      shiftDays.set(r.employee_ms_id, days);
    }
  }
  for (const [id, days] of shiftDays) byId.get(id)!.shifts = days.size;
  return { list: [...byId.values()].sort((a, b) => b.revenue - a.revenue), planOf };
}

function sumOf(list: Total[]): Total {
  return list.reduce(
    (s, a) => ({
      revenue: s.revenue + a.revenue,
      receipts: s.receipts + a.receipts,
      items: s.items + a.items,
      retAmount: s.retAmount + a.retAmount,
      retReceipts: s.retReceipts + a.retReceipts,
      retItems: s.retItems + a.retItems,
      shifts: s.shifts + a.shifts,
    }),
    { ...EMPTY }
  );
}

// Строки с цифрами под именем: чеки, товары, средний чек, глубина чека, смены, возвраты.
function detailLines(a: Total): string[] {
  const lines = [
    `  чеков ${num(a.receipts)} · колич.товара ${num(a.items)}`,
    `  ср.чек ${avgCheck(a)} · гл.чек ${depth(a)}`,
  ];
  if (a.shifts > 0) {
    lines.push(`  смен ${num(a.shifts)}`, `  в среднем за смену ${money(a.revenue / a.shifts)}`);
  }
  if (a.retAmount > 0 || a.retReceipts > 0 || a.retItems > 0) {
    const parts = [money(a.retAmount)];
    if (a.retReceipts > 0) parts.push(`${num(a.retReceipts)} чек`);
    if (a.retItems > 0) parts.push(`${num(a.retItems)} тов.`);
    lines.push(`  возвраты ${parts.join(" · ")}`);
  }
  return lines;
}

function totalLines(label: string, total: Total): string[] {
  return [`${label.padEnd(13)}${money(total.revenue).padStart(13)}`, ...detailLines(total)];
}

// Таблица стилистов города (с планом за месяц) и итог по городу.
function cityLines(list: Agg[], planOf: Map<string, number>, period: Period): string[] {
  const lines: string[] = [];
  for (const a of list) {
    lines.push(`${shortName(a.name).slice(0, 13).padEnd(13)}${money(a.revenue).padStart(13)}`, ...detailLines(a));
    const plan = planOf.get(a.id);
    if (period === "m" && plan !== undefined && plan > 0) {
      lines.push(`  план ${money(plan)} · ${((a.revenue / plan) * 100).toFixed(1)}%`);
    }
  }
  lines.push("─".repeat(26), ...totalLines("Итого", sumOf(list)));
  return lines;
}

// store — код города или "all" (все города, каждый отдельным блоком и общий итог).
async function buildReport(store: string, period: Period, custom?: Range): Promise<string> {
  const { from, to } = rangeFor(period, custom);
  const label = store === "all" ? "Все города" : (CITY[store] ?? store);
  // Для своего периода показываем даты с годом, если он не текущий.
  const fmt = (d: string) => (d.slice(0, 4) === todayInAlmaty().slice(0, 4) ? shortDate(d) : `${shortDate(d)}.${d.slice(0, 4)}`);
  const title = `📊 <b>Продажи · ${label}</b>\n${PERIOD_LABEL[period]}: ${from === to ? fmt(from) : `${fmt(from)}–${fmt(to)}`} (по вчера)`;
  if (from > to) return `${title}\n\nЗа этот период данных ещё нет.`;

  const cities = store === "all" ? ALL_STORES : [store];
  const data = await Promise.all(cities.map((c) => cityData(c, period, custom)));
  if (data.every((d) => d.list.length === 0)) return `${title}\n\nПродаж за этот период нет.`;

  if (store !== "all") return `${title}\n${pre(cityLines(data[0].list, data[0].planOf, period).join("\n"))}`;

  const blocks = cities.map((c, i) =>
    data[i].list.length === 0
      ? `<b>${CITY[c]}</b>: продаж нет.`
      : `<b>${CITY[c]}</b>${pre(cityLines(data[i].list, data[i].planOf, period).join("\n"))}`
  );
  const all = sumOf(data.flatMap((d) => d.list));
  return `${title}\n\n${blocks.join("\n")}\n<b>Всего по городам</b>${pre(totalLines("Итого", all).join("\n"))}`;
}

// Нажатия adm:s… ; stores — города, доступные этому администратору.
export async function handleSalesCallback(parts: string[], t: Transport, chatId: number | string, stores: string[], userId: number) {
  // adm:s | adm:s:m:<режим> | adm:s:c:<режим>:<город> | adm:s:p:<режим>:<город>:<период> | adm:s:x:<режим>:<город>
  // режим: e — по сотрудникам, k — по городу (общая касса)
  const kind = parts[2];
  await setAwaiting(userId, null); // любое нажатие снимает ожидание ввода дат
  if (!kind) {
    await sendSalesStart(t, chatId);
    return;
  }
  const mode: Mode = parts[3] === "k" ? "k" : "e";
  if (kind === "m") {
    await sendCityMenu(t, chatId, mode, stores);
    return;
  }
  const store = parts[4];
  // Чужой город — игнорируем; «Все города» — только тому, у кого их больше одного.
  if (!store || (store === "all" ? stores.length < 2 : !stores.includes(store))) return;
  if (kind === "c") {
    await sendPeriodMenu(t, chatId, mode, store, stores.length > 1);
    return;
  }
  if (kind === "x") {
    // Просим написать даты: следующее текстовое сообщение разберёт handleCustomPeriodInput.
    await setAwaiting(userId, `sales:${mode}:${store}`);
    await t.send(
      chatId,
      `✏️ <b>Свой период · ${MODE_LABEL[mode]} · ${store === "all" ? "Все города" : (CITY[store] ?? store)}</b>\nНапишите даты сообщением:\n• <b>01.10-15.10</b> — с какого по какое\n• <b>05.10</b> — один день\nГод можно не указывать. Данные есть по вчерашний день.`,
      { inline_keyboard: [[{ text: "Отмена", callback_data: `adm:s:c:${mode}:${store}` }]] }
    );
    return;
  }
  const period = parts[5] as Period;
  if (kind !== "p" || !(period in PERIOD_LABEL) || period === "c") return;
  await sendReport(t, chatId, mode, store, period);
}

// Условный отчёт для тестового руководителя: выдуманные стилисты и цифры.
export async function sendDemoSales(t: Transport, chatId: number | string) {
  const lines = [
    `${"Айгерим".padEnd(13)}${money(1_240_000).padStart(13)}`,
    "  чеков 41 · ср.чек 30 244 ₸",
    `${"Мадина".padEnd(13)}${money(980_000).padStart(13)}`,
    "  чеков 33 · ср.чек 29 697 ₸",
    `${"Динара".padEnd(13)}${money(655_000).padStart(13)}`,
    "  чеков 25 · ср.чек 26 200 ₸",
    "─".repeat(26),
    `${"Итого".padEnd(13)}${money(2_875_000).padStart(13)}`,
    "  чеков 99 · ср.чек 29 040 ₸",
  ];
  await t.send(
    chatId,
    `🧪 <i>Тестовый режим: сотрудники и цифры выдуманные.</i>\n\n📊 <b>Продажи · Актау</b>\nЗа последние 7 дней\n${pre(lines.join("\n"))}`
  );
}
