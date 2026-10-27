// Раздел «Продажи» для администратора бота: продажи стилистов-консультантов по
// выбранному городу за сегодня, вчера, эту и прошлую неделю, этот и прошлый месяц или свой период. Администратор видит
// только свои города (admin_scope: 'city' — свой, 'all' — все).
import { trim2 } from "@/lib/numFormat";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { SCOPES, buildCashReport, buildIntradayReport, money, num, pre, shortName } from "@/lib/reports/sales";
import { fetchRetailDemandsForDate, fetchRetailSalesReturnsForDate } from "@/lib/moysklad";
import { aggregateSales } from "@/lib/salesAggregate";
import { type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { addDays, daysBetween, employeeDayPlans, loadEmployeeDays, monthEndOf, monthStartOf, mondayOf, shortDate, todayInAlmaty } from "@/lib/coach/metrics";
import { loadPeriod } from "@/lib/reports/weeklyCompare";

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const HIDDEN_NAME = /саяпарк|saya/i;
// Периоды одинаковые во всех режимах: сегодня, вчера, эта и прошлая неделя, этот и прошлый месяц; c — свой период (даты вводятся текстом).
type Period = "t" | "y" | "cw" | "pw" | "m" | "pm" | "c";
const PERIOD_LABEL: Record<Period, string> = { t: "Сегодня", y: "Вчера", cw: "Эта неделя", pw: "Прошлая неделя", m: "Этот месяц", pm: "Прошлый месяц", c: "Свой период" };
const PERIOD_ORDER: Period[] = ["t", "y", "cw", "pw", "m", "pm"];
type Range = { from: string; to: string };
const MAX_CUSTOM_DAYS = 366;
const MAX_PLAN_DAYS = 62; // «Продажи и план»: по дням, слишком длинную таблицу не читать
const CASH_MAX_DAYS = 31; // касса города (оплаты и возвраты тянутся из МойСклад — дольше не успевает)
const CASH_MAX_DAYS_ALL = 20; // касса по всем городам (два города подряд)

export const ALL_STORES = Object.keys(CITY);

// Что показывать: продажи по сотрудникам (e) или общая касса города (k).
type Mode = "e" | "k" | "p" | "q"; // q — план продаж по сотрудникам
const MODE_LABEL: Record<Mode, string> = { e: "по сотрудникам", k: "по городу (общая касса)", p: "и план продаж", q: "· план по сотрудникам" };

// Вход в раздел: сначала выбор — по сотрудникам или по городу (общая касса).
export async function sendSalesStart(t: Transport, chatId: number | string, _stores?: string[]) {
  await t.send(chatId, "📊 <b>Продажи</b>\nЧто показать?", {
    inline_keyboard: [
      [{ text: "👥 По сотрудникам", callback_data: "adm:s:m:e" }],
      [{ text: "🏙 По городу (общая касса)", callback_data: "adm:s:m:k" }],
      [{ text: "📈 Продажи и план продаж", callback_data: "adm:s:m:p" }],
      [{ text: "👥 План продаж по сотрудникам", callback_data: "adm:s:m:q" }],
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
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < PERIOD_ORDER.length; i += 2) {
    rows.push(PERIOD_ORDER.slice(i, i + 2).map((p) => ({ text: PERIOD_LABEL[p], callback_data: `adm:s:p:${mode}:${store}:${p}` })));
  }
  rows.push([{ text: "✏️ Свой период", callback_data: `adm:s:x:${mode}:${store}` }]);
  // Назад: к выбору города (если городов несколько) или к выбору «по сотрудникам / по городу».
  rows.push([{ text: "← Назад", callback_data: canGoBack ? `adm:s:m:${mode}` : "adm:s" }]);
  await t.send(
    chatId,
    `📊 <b>Продажи ${MODE_LABEL[mode]} · ${store === "all" ? "Все города" : (CITY[store] ?? store)}</b>\nЗа какой период?`,
    { inline_keyboard: rows }
  );
}

function rangeFor(period: Period, custom?: Range, plan = false): Range {
  const today = todayInAlmaty();
  const yesterday = addDays(today, -1);
  const monday = mondayOf(today);
  const prevMonthEnd = addDays(monthStartOf(today), -1);
  if (period === "c" && custom) {
    // «Продажи и план»: план есть и на будущие дни — ничего не обрезаем; в остальных режимах данные есть по вчера: будущие даты обрезаем.
    return plan ? custom : { from: custom.from, to: custom.to > yesterday ? yesterday : custom.to };
  }
  if (period === "t") return { from: today, to: today };
  if (period === "y") return { from: yesterday, to: yesterday };
  if (period === "pw") return { from: addDays(monday, -7), to: addDays(monday, -1) };
  if (period === "pm") return { from: monthStartOf(prevMonthEnd), to: prevMonthEnd };
  // «Продажи и план» — неделя и месяц целиком (план есть и на будущие дни); остальное — по вчера, на понедельник «эта неделя» ещё пуста
  if (period === "cw") return plan ? { from: monday, to: addDays(monday, 6) } : { from: monday, to: yesterday };
  return plan ? { from: monthStartOf(today), to: monthEndOf(today) } : { from: monthStartOf(today), to: yesterday };
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
  const mode: Mode = modeRaw === "k" ? "k" : modeRaw === "p" ? "p" : modeRaw === "q" ? "q" : "e";
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
  const maxDays = mode === "p" || mode === "q" ? MAX_PLAN_DAYS : MAX_CUSTOM_DAYS;
  if (daysBetween(range.from, range.to) + 1 > maxDays) {
    await t.send(chat, `Период слишком длинный — не больше ${maxDays} дней. Напишите ещё раз.`, retry);
    return;
  }
  await setAwaiting(user.id, null);
  await sendReport(t, chat, mode, store, "c", range);
}

// Общая касса города за период (для «Все города» — касса каждого города и общий итог).
async function buildCashMessages(store: string, period: Period, custom?: Range): Promise<string[]> {
  if (period === "t") {
    // сегодня — живые данные: тот же отчёт, что приходит в группы днём, но за весь день до этой минуты
    const today = todayInAlmaty();
    const todayScopes = store === "all" ? [SCOPES.point_1, SCOPES.point_3, SCOPES.all] : [SCOPES[store]];
    const out: string[] = [];
    for (const scope of todayScopes) out.push(...(await buildIntradayReport(scope, today, 24)));
    return out;
  }
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
  let messages: string[];
  try {
    messages = mode === "k" ? await buildCashMessages(store, period, custom) : mode === "p" ? [await buildPlanReport(store, period, custom)] : mode === "q" ? [await buildEmployeePlanReport(store, period, custom)] : [await buildReport(store, period, custom)];
  } catch (e) {
    messages = [`Не удалось собрать продажи: ${escapeHtml(e instanceof Error ? e.message : String(e))}`];
  }
  messages = messages.flatMap((m) => splitLong(m));
  // Без кнопок под отчётом: он остаётся в чате, другой период выбирают заново через меню.
  for (const message of messages) await t.send(chatId, message);
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
const depth = (a: Total) => (a.receipts > 0 ? trim2((a.items / a.receipts)) : "—");

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

// Сегодняшний день ещё не загружен в базу (она обновляется ночью) — берём чеки сегодняшнего дня прямо из МойСклад, как в дневном отчёте.
async function liveTodayList(store: string): Promise<Agg[]> {
  const today = todayInAlmaty();
  const [demands, returns] = await Promise.all([fetchRetailDemandsForDate(today), fetchRetailSalesReturnsForDate(today)]);
  const agg = await aggregateSales(today, demands, returns);
  const list: Agg[] = [];
  for (const [key, e] of agg.byEmployee) {
    if (e.store !== store || HIDDEN_NAME.test(e.name)) continue;
    const shifts = e.receipts > 0 || e.revenue > 0 ? 1 : 0;
    list.push({ id: key.slice(0, key.lastIndexOf("|")), name: e.name, revenue: e.revenue, receipts: e.receipts, items: e.items, retAmount: e.returnedAmount, retReceipts: e.returnedReceipts, retItems: e.returnedItems, shifts });
  }
  return list.sort((a, b) => b.revenue - a.revenue);
}

async function cityData(store: string, period: Period, custom?: Range): Promise<{ list: Agg[]; planOf: Map<string, number> }> {
  if (period === "t") return { list: await liveTodayList(store), planOf: new Map() };
  const { from, to } = rangeFor(period, custom);
  const [salesRows, plans] = await Promise.all([
    loadSales(store, from, to),
    period === "m" || period === "pm"
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
    if ((period === "m" || period === "pm") && plan !== undefined && plan > 0) {
      lines.push(`  план ${money(plan)} · ${trim2(((a.revenue / plan) * 100))}%`);
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
  const title = `📊 <b>Продажи · ${label}</b>\n${PERIOD_LABEL[period]}: ${from === to ? fmt(from) : `${fmt(from)}–${fmt(to)}`} ${period === "t" ? "(сейчас)" : "(по вчера)"}`;
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

// ---- Продажи и план продаж: по дням план оборота города (по долям дней недели, как в окне «План продаж» на портале) и факт ----

const WEEKDAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAY_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${shortDate(date)}`;
}
const pctText = (fact: number, plan: number) => (plan > 0 ? `${trim2((fact / plan) * 100)}%` : "—");

type PlanDay = { date: string; plan: number; addOn: number; fact: number | null }; // fact null — день ещё не закончился; addOn — недобор месяца на этот день

async function planDays(store: string, from: string, to: string): Promise<{ days: PlanDay[]; monthPlan: number }> {
  const today = todayInAlmaty();
  const w = await loadPeriod(store, from, to, false, true);
  return { days: w.days.map((d) => ({ date: d.date, plan: d.planRevenue, addOn: d.addOn ?? 0, fact: d.date < today ? d.revenue : null })), monthPlan: w.monthPlan ?? 0 };
}

function planTotals(days: PlanDay[]) {
  const planAll = days.reduce((a, d) => a + d.plan, 0);
  const addOnAll = days.reduce((a, d) => a + d.addOn, 0);
  const past = days.filter((d) => d.fact !== null);
  return { planAll, addOnAll, planPast: past.reduce((a, d) => a + d.plan, 0), fact: past.reduce((a, d) => a + (d.fact ?? 0), 0), pastCount: past.length };
}

// «+ недобор» (месяц отстаёт) или «− опережение» (идёт с запасом): строки для итогов; пусто, если добавки нет.
function addOnRows(planAll: number, addOnAll: number): string[] {
  if (addOnAll > 0) return [`+ недобор ${money(addOnAll)}`, `Всего ${money(planAll + addOnAll)}`];
  if (addOnAll < 0) return [`− опережение ${money(-addOnAll)}`, `Всего ${money(planAll + addOnAll)}`];
  return [];
}

// monthPlan — только для периода «Месяц»: в итогах показываем план месяца, а не сумму дневных планов.
function planCityBlock(days: PlanDay[], monthPlan?: number): string[] {
  if (days.length === 1) {
    const d = days[0];
    const lines = [dayLabel(d.date), `План дня   ${money(d.plan)}`];
    if (d.fact === null) {
      lines.push(...addOnRows(d.plan, d.addOn));
      lines.push(d.date === todayInAlmaty() ? "Факт: появится после ночной загрузки (утром)" : "Факт: день ещё не наступил");
    } else lines.push(`Факт       ${money(d.fact)}`, `Выполнение ${pctText(d.fact, d.plan)}`, d.fact >= d.plan ? `Сверх плана ${money(d.fact - d.plan)}` : `До плана    ${money(d.plan - d.fact)}`);
    return lines;
  }
  const lines = [`${"день".padEnd(9)}${"план".padStart(11)}${"факт".padStart(11)}${"%".padStart(6)}`];
  for (const d of days) {
    lines.push(`${dayLabel(d.date).padEnd(9)}${num(d.plan).padStart(11)}${(d.fact === null ? "—" : num(d.fact)).padStart(11)}${(d.fact === null ? "" : pctText(d.fact, d.plan)).padStart(6)}`);
  }
  const t = planTotals(days);
  if (monthPlan !== undefined && monthPlan > 0) {
    lines.push("─".repeat(37), `План месяца ${money(monthPlan)}`, `Факт ${money(t.fact)}`, `Выполнение ${pctText(t.fact, monthPlan)}`);
    if (t.fact < monthPlan) lines.push(`Осталось ${money(monthPlan - t.fact)}`);
    const left = days.filter((d) => d.fact === null && d.addOn !== 0);
    if (t.addOnAll !== 0 && left.length > 0) lines.push(`${t.addOnAll > 0 ? "+ недобор" : "− опережение"} на каждый из ${left.length} дн.: ${money(Math.abs(left[0].addOn))}`);
    return lines;
  }
  lines.push("─".repeat(37), `План периода ${money(t.planAll)}`, ...addOnRows(t.planAll, t.addOnAll));
  if (t.pastCount > 0) lines.push(`План за прошедшие дни ${money(t.planPast)}`, `Факт ${money(t.fact)}`, `Выполнение ${pctText(t.fact, t.planPast)}`);
  return lines;
}

async function buildPlanReport(store: string, period: Period, custom?: Range): Promise<string> {
  const { from, to } = rangeFor(period, custom, true);
  const fmt = (d: string) => (d.slice(0, 4) === todayInAlmaty().slice(0, 4) ? shortDate(d) : `${shortDate(d)}.${d.slice(0, 4)}`);
  const label = store === "all" ? "Все города" : (CITY[store] ?? store);
  const title = `📈 <b>Продажи и план продаж · ${label}</b>\n${PERIOD_LABEL[period]}: ${from === to ? fmt(from) : `${fmt(from)}–${fmt(to)}`}`;
  const cities = store === "all" ? ALL_STORES : [store];
  const data = await Promise.all(cities.map(async (c) => ({ c, ...(await planDays(c, from, to)) })));
  const isMonth = period === "m";
  const note = "\n<i>План дня — по долям дней недели; «+ недобор» — недобор месяца, поделённый поровну на оставшиеся дни (вместе они приводят к плану месяца). Факт — по вчера включительно.</i>";
  if (cities.length === 1) return `${title}\n${pre(planCityBlock(data[0].days, isMonth ? data[0].monthPlan : undefined).join("\n"))}${note}`;
  const blocks = data.map(({ c, days, monthPlan }) => `<b>${CITY[c]}</b>${pre(planCityBlock(days, isMonth ? monthPlan : undefined).join("\n"))}`);
  const total = data.reduce(
    (a, { days, monthPlan }) => {
      const t = planTotals(days);
      return { planAll: a.planAll + t.planAll, addOnAll: a.addOnAll + t.addOnAll, planPast: a.planPast + t.planPast, fact: a.fact + t.fact, pastCount: Math.max(a.pastCount, t.pastCount), monthPlan: a.monthPlan + monthPlan };
    },
    { planAll: 0, addOnAll: 0, planPast: 0, fact: 0, pastCount: 0, monthPlan: 0 }
  );
  const sum =
    isMonth && total.monthPlan > 0
      ? [`План месяца ${money(total.monthPlan)}`, `Факт ${money(total.fact)}`, `Выполнение ${pctText(total.fact, total.monthPlan)}`, ...(total.fact < total.monthPlan ? [`Осталось ${money(total.monthPlan - total.fact)}`] : [])]
      : [`План ${money(total.planAll)}`, ...addOnRows(total.planAll, total.addOnAll), ...(total.pastCount > 0 ? [`План за прошедшие дни ${money(total.planPast)}`, `Факт ${money(total.fact)}`, `Выполнение ${pctText(total.fact, total.planPast)}`] : [])];
  return `${title}\n\n${blocks.join("\n")}\n<b>Всего по городам</b>${pre(sum.join("\n"))}${note}`;
}

// ---- План продаж по сотрудникам: личный план каждого продавца города за период, «+ недобор» и факт ----
// План — личный (по плану сотрудника на месяц, доли дней недели), недобор — его месячный недобор, поделённый поровну на оставшиеся дни;
// % — факт к плану прошедших дней. Сотрудники без плана на месяц не показываются.

type EmpPlanRow = { id: string; name: string; plan: number; addOn: number; planPast: number; fact: number };

async function employeePlanRows(store: string, from: string, to: string): Promise<EmpPlanRow[]> {
  const today = todayInAlmaty();
  const yesterday = addDays(today, -1);
  const months: string[] = [];
  for (let m = monthStartOf(from); m <= to; m = monthStartOf(addDays(monthEndOf(m), 1))) months.push(m);
  const { data, error } = await supabaseAdmin.from("sales_plan_monthly").select("employee_ms_id, employee_name, sales_plan").eq("store", store).in("plan_month", months);
  if (error) throw error;
  const people = new Map<string, string>();
  for (const r of (data ?? []) as { employee_ms_id: string; employee_name: string; sales_plan: number | null }[]) {
    if ((Number(r.sales_plan) || 0) > 0 && !HIDDEN_NAME.test(r.employee_name)) people.set(r.employee_ms_id, r.employee_name);
  }
  const rows = await Promise.all(
    [...people.entries()].map(async ([id, name]): Promise<EmpPlanRow> => {
      const emp = { id, name, store };
      const [plans, days] = await Promise.all([employeeDayPlans(emp, from, to), from <= yesterday ? loadEmployeeDays(id, from, to < yesterday ? to : yesterday) : Promise.resolve([])]);
      const factOf = new Map(days.map((d) => [d.date, d.revenue]));
      let plan = 0;
      let addOn = 0;
      let planPast = 0;
      let fact = 0;
      for (const d of plans) {
        plan += d.plan ?? 0;
        addOn += d.addOn;
        if (d.date < today) {
          planPast += d.plan ?? 0;
          fact += factOf.get(d.date) ?? 0;
        }
      }
      return { id, name, plan, addOn, planPast, fact };
    })
  );
  return rows.filter((r) => r.plan > 0).sort((a, b) => b.plan - a.plan);
}

function employeePlanLines(rows: EmpPlanRow[]): string[] {
  const lines = [`${"сотрудник".padEnd(13)}${"план".padStart(11)}${"факт".padStart(11)}${"%".padStart(6)}`];
  for (const r of rows) {
    lines.push(`${shortName(r.name).slice(0, 13).padEnd(13)}${num(r.plan).padStart(11)}${(r.planPast > 0 || r.fact > 0 ? num(r.fact) : "—").padStart(11)}${(r.planPast > 0 ? pctText(r.fact, r.planPast) : "").padStart(6)}`);
    if (r.addOn > 0) lines.push(`  + недобор ${money(r.addOn)} (всего ${money(r.plan + r.addOn)})`);
    else if (r.addOn < 0) lines.push(`  − опережение ${money(-r.addOn)} (всего ${money(r.plan + r.addOn)})`);
  }
  const plan = rows.reduce((a, r) => a + r.plan, 0);
  const addOn = rows.reduce((a, r) => a + r.addOn, 0);
  const planPast = rows.reduce((a, r) => a + r.planPast, 0);
  const fact = rows.reduce((a, r) => a + r.fact, 0);
  lines.push("─".repeat(37), `Итого план ${money(plan)}`);
  if (addOn > 0) lines.push(`+ недобор ${money(addOn)} (всего ${money(plan + addOn)})`);
  else if (addOn < 0) lines.push(`− опережение ${money(-addOn)} (всего ${money(plan + addOn)})`);
  if (planPast > 0) lines.push(`Факт ${money(fact)}`, `Выполнение ${pctText(fact, planPast)}`);
  return lines;
}

async function buildEmployeePlanReport(store: string, period: Period, custom?: Range): Promise<string> {
  const { from, to } = rangeFor(period, custom, true);
  const fmt = (d: string) => (d.slice(0, 4) === todayInAlmaty().slice(0, 4) ? shortDate(d) : `${shortDate(d)}.${d.slice(0, 4)}`);
  const label = store === "all" ? "Все города" : (CITY[store] ?? store);
  const title = `👥 <b>План продаж по сотрудникам · ${label}</b>\n${PERIOD_LABEL[period]}: ${from === to ? fmt(from) : `${fmt(from)}–${fmt(to)}`}`;
  const cities = store === "all" ? ALL_STORES : [store];
  const data = await Promise.all(cities.map(async (c) => ({ c, rows: await employeePlanRows(c, from, to) })));
  const note = "\n<i>План — личный план сотрудника по долям дней недели; «+ недобор» — его недобор месяца, поделённый поровну на оставшиеся дни. % — факт к плану прошедших дней. Без плана на месяц сотрудники не показываются.</i>";
  if (data.every((d) => d.rows.length === 0)) return `${title}\n\nПлан на этот период по сотрудникам не внесён.${note}`;
  if (cities.length === 1) return `${title}\n${pre(employeePlanLines(data[0].rows).join("\n"))}${note}`;
  return `${title}\n\n${data.map(({ c, rows }) => `<b>${CITY[c]}</b>${rows.length === 0 ? " — плана нет." : pre(employeePlanLines(rows).join("\n"))}`).join("\n")}${note}`;
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
  const mode: Mode = parts[3] === "k" ? "k" : parts[3] === "p" ? "p" : parts[3] === "q" ? "q" : "e";
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
