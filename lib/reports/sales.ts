import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { warehousesForCities } from "@/lib/warehouses";
import { escapeHtml, packSections } from "@/lib/telegram";
import {
  fetchLtvChecksForRange,
  fetchPaymentSummariesForRange,
  fetchRetailDemandSummariesForDate,
} from "@/lib/moysklad";

// compact: укороченный формат — без маржи, Instagram, публикаций, рекламы и
// топа товаров, зато с количеством товара в итогах дня. У Актау и Актобе
// (одинаковый формат); общий отчёт «all» остаётся полным и сейчас никуда не уходит.
export type ReportScope = { key: string; title: string; cityCodes: string[]; compact?: boolean };

// cityCodes are the city-level codes (point_1/point_3) moysklad_sales_daily,
// traffic_entries and publication_entries use; the per-warehouse codes the
// product tables use come from warehousesForCities.
export const SCOPES: Record<string, ReportScope> = {
  point_1: { key: "point_1", title: "Overman Актау", cityCodes: ["point_1"], compact: true },
  point_3: { key: "point_3", title: "Overman Актобе", cityCodes: ["point_3"], compact: true },
  all: { key: "all", title: "Overman · все города", cityCodes: ["point_1", "point_3"] },
};

const NOT_CONFIGURED = "<i>не настроено на сайте</i>";

const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
function num(n: number): string {
  return nf.format(Math.round(n)).replace(/[  ]/g, " ");
}
function money(n: number): string {
  return `${num(n)} ₸`;
}
function pct(revenue: number, cost: number | null): string {
  if (cost === null || revenue <= 0) return "—";
  return `${Math.round(((revenue - cost) / revenue) * 100)}%`;
}
function fit(s: string, width: number): string {
  const chars = [...s];
  return chars.length > width ? chars.slice(0, width - 1).join("") + "…" : s.padEnd(width);
}

// Fixed-width table for a <pre> block — widths keep each line within what a
// phone shows without wrapping (~34 chars).
function table(headers: string[], rows: string[][], widths: number[], leftCols: number, gap = 1): string {
  const sep = " ".repeat(gap);
  const line = (cells: string[]) =>
    cells.map((c, i) => (i < leftCols ? fit(c, widths[i]) : c.padStart(widths[i]))).join(sep);
  const total = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * gap;
  return [line(headers), "─".repeat(total), ...rows.map(line)].join("\n");
}

function section(title: string, body: string): string {
  return `<b>—— ${title} ——</b>\n${body}`;
}
// Первой строкой блока идёт пустая (невидимый символ U+2800: обычный перевод
// строки Telegram срезает), чтобы кнопка «копировать» поверх блока не мешала тексту.
function pre(text: string): string {
  return `<pre>⠀\n${escapeHtml(text)}</pre>`;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
function dateLabel(date: string): string {
  const d = parseYmd(date);
  const [y, m, day] = date.split("-");
  return `${day}.${m}.${y}, ${WEEKDAYS[d.getUTCDay()]}`;
}

// Kazakhstan has one fixed zone (UTC+5, no DST); the server runs in UTC.
export function yesterdayInAlmaty(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date()).split("-").map(Number);
  const today = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  today.setUTCDate(today.getUTCDate() - 1);
  return ymd(today);
}

type SalesRow = {
  register_id: string;
  revenue: number;
  receipts_count: number;
  items_count: number;
  cost: number | null;
  returned_amount: number | null;
  returned_receipts: number | null;
  returned_items: number | null;
  sale_date: string;
  moysklad_registers: { name: string; store: string | null } | { name: string; store: string | null }[] | null;
};

function registerOf(row: SalesRow) {
  const r = row.moysklad_registers;
  return Array.isArray(r) ? r[0] ?? null : r;
}

async function loadSales(scope: ReportScope, from: string, to: string): Promise<SalesRow[]> {
  const { data, error } = await supabaseAdmin
    .from("moysklad_sales_daily")
    .select(
      "register_id, revenue, receipts_count, items_count, cost, returned_amount, returned_receipts, returned_items, sale_date, moysklad_registers(name, store)"
    )
    .gte("sale_date", from)
    .lte("sale_date", to);
  if (error) throw error;
  return ((data ?? []) as unknown as SalesRow[]).filter((r) => {
    const store = registerOf(r)?.store;
    return !!store && scope.cityCodes.includes(store);
  });
}

function sumCost(rows: { cost: number | null }[]): number | null {
  let sum = 0;
  for (const r of rows) {
    if (r.cost === null) return null;
    sum += r.cost;
  }
  return sum;
}

function kpiBlock(rows: SalesRow[], visitors: number, compact: boolean): string {
  const revenue = rows.reduce((a, r) => a + r.revenue, 0);
  const receipts = rows.reduce((a, r) => a + r.receipts_count, 0);
  const items = rows.reduce((a, r) => a + r.items_count, 0);
  const cost = sumCost(rows);
  const line = (label: string, value: string) => `${label.padEnd(15)}${value.padStart(17)}`;
  const conversion = line(
    "Конверсия",
    visitors > 0 ? `${Math.round((receipts / visitors) * 100)}% (${receipts}/${num(visitors)})` : "нет трафика"
  );
  const lines = compact
    ? [
        line("Выручка", money(revenue)),
        line("Чеков", num(receipts)),
        line("Товара, шт", num(items)),
        line("Средний чек", receipts > 0 ? money(revenue / receipts) : "—"),
        line("Глубина чека", receipts > 0 ? (items / receipts).toFixed(2) : "—"),
      ]
    : [
        line("Выручка", money(revenue)),
        line("Чеков", num(receipts)),
        line("Средний чек", receipts > 0 ? money(revenue / receipts) : "—"),
        line("Глубина чека", receipts > 0 ? (items / receipts).toFixed(2) : "—"),
        line("Маржа", pct(revenue, cost)),
        conversion,
      ];
  return pre(lines.join("\n"));
}

// Раздел «ТРАФИК» (Актау, в самом низу): план (в скобках его выполнение в %),
// факт, чеки и конверсия. План берётся из traffic_entries.traffic_plan.
function trafficBlock(receipts: number, visitors: number, plan: number): string {
  const line = (label: string, value: string) => `${label.padEnd(15)}${value.padStart(17)}`;
  // Ничего не округляем до целых: везде два знака после точки (х.хх).
  const planValue = plan > 0 ? `${plan.toFixed(2)} (${((visitors / plan) * 100).toFixed(2)}%)` : "—";
  return pre(
    [
      line("План", planValue),
      line("Факт", visitors > 0 ? visitors.toFixed(2) : "—"),
      line("Чек", num(receipts)),
      line("Конверсия", visitors > 0 ? `${((receipts / visitors) * 100).toFixed(2)}%` : "—"),
    ].join("\n")
  );
}

// Раздел «LTV» (Актау, после «ТРАФИК»; в дневном, недельном и месячном отчётах):
// чеки периода по покупателям.
//  · Свои — покупатель уже был в базе до дня этого чека (создан раньше начала дня);
//  · Новые — все чеки, кроме своих;
//  · Зарег — новые, кто зарегистрировался в день чека (не «Розничный покупатель»);
//  · Не зарег — чеки на «Розничного покупателя».
// Проценты везде: свои и новые — от всех чеков, зарег и не зарег — от новых.
// Ниже — сколько розничных чеков провёл каждый сотрудник и какую долю это
// составляет от всех его чеков (кто не проводил — того нет в списке).
async function ltvBlock(dayRows: SalesRow[], from: string, to: string): Promise<string> {
  const registerIds = new Set(dayRows.map((r) => r.register_id));
  const checks = (await fetchLtvChecksForRange(from, to)).filter((c) => registerIds.has(c.retailStoreId));
  if (checks.length === 0) return `<i>за ${from === to ? "день" : "период"} продаж нет</i>`;

  // Начало дня чека: у дневного отчёта — сам день отчёта (чеки после полуночи до
  // 02:00 входят в него же); у периода — календарный день чека.
  const dayStartOf = (c: { moment: string }) => (from === to ? `${from} 00:00:00` : `${c.moment.slice(0, 10)} 00:00:00`);
  const isRetail = (c: { agentName: string }) => !c.agentName || c.agentName.trim().toLowerCase() === "розничный покупатель";
  const retail = checks.filter(isRetail);
  const own = checks.filter((c) => !isRetail(c) && c.agentCreated !== null && c.agentCreated < dayStartOf(c));
  const total = checks.length;
  const fresh = total - own.length;
  const registered = fresh - retail.length;
  const p = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(2)}%` : "—");

  const line = (label: string, value: string) => `${label.padEnd(15)}${value.padStart(17)}`;
  const lines = [
    line("Чек", num(total)),
    line("Свои", `${num(own.length)} (${p(own.length, total)})`),
    line("Новые", `${num(fresh)} (${p(fresh, total)})`),
    line("Зарег", `${num(registered)} (${p(registered, fresh)})`),
    line("Не зарег", `${num(retail.length)} (${p(retail.length, fresh)})`),
  ];

  const byEmployee = new Map<string, { retail: number; all: number }>();
  for (const c of checks) {
    const name = c.ownerName || "—";
    const agg = byEmployee.get(name) ?? { retail: 0, all: 0 };
    agg.all++;
    if (isRetail(c)) agg.retail++;
    byEmployee.set(name, agg);
  }
  const withRetail = [...byEmployee.entries()].filter(([, a]) => a.retail > 0).sort((a, b) => b[1].retail - a[1].retail);
  if (withRetail.length > 0) {
    lines.push("", "Розничный покупатель:");
    for (const [name, a] of withRetail) {
      lines.push(`${fit(name, 15)}${`${num(a.retail)} (${p(a.retail, a.all)})`.padStart(17)}`);
    }
  }
  return pre(lines.join("\n"));
}

// «По способу оплаты» (Актау вместо «По кассам»): наличные и безнал по данным
// МойСклад за те же кассы, что вошли в итоги дня. Возвраты вычитаются, как и из
// выручки, так что нал + безнал = выручка дня. Безнал = всё, что не наличные
// (карта, QR).
async function paymentBlock(dayRows: SalesRow[], from: string, to: string): Promise<string> {
  const registerIds = new Set(dayRows.map((r) => r.register_id));
  const payments = await fetchPaymentSummariesForRange(from, to);
  let total = 0;
  let cash = 0;
  for (const p of payments) {
    if (!registerIds.has(p.retailStoreId)) continue;
    const sign = p.kind === "sale" ? 1 : -1;
    total += sign * p.sum;
    cash += sign * p.cash;
  }
  const line = (label: string, value: string) => `${label.padEnd(15)}${value.padStart(17)}`;
  return pre([line("Наличные", money(cash / 100)), line("Безнал", money((total - cash) / 100))].join("\n"));
}

function kassaBlock(rows: SalesRow[], compact: boolean): string {
  const byRegister = new Map<string, { revenue: number; items: number; costs: (number | null)[] }>();
  for (const r of rows) {
    const name = registerOf(r)?.name ?? "—";
    const agg = byRegister.get(name) ?? { revenue: 0, items: 0, costs: [] };
    agg.revenue += r.revenue;
    agg.items += r.items_count;
    agg.costs.push(r.cost);
    byRegister.set(name, agg);
  }
  const sorted = [...byRegister.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  if (sorted.length === 0) return `<i>за день продаж нет</i>`;
  if (compact) {
    return pre(table(["Касса", "Выручка", "Шт"], sorted.map(([name, a]) => [name, num(a.revenue), num(a.items)]), [18, 9, 3], 1));
  }
  const list = sorted.map(([name, a]) => [
    name,
    num(a.revenue),
    num(a.items),
    pct(a.revenue, sumCost(a.costs.map((c) => ({ cost: c })))),
  ]);
  return pre(table(["Касса", "Выручка", "Шт", "Маржа"], list, [16, 7, 3, 5], 1));
}

// Склонение по модулю: у возвратов чеков может быть минус («−1 чек»), а в JS
// -1 % 10 === -1, из-за чего без abs любой минус давал бы «чеков».
function checksWord(n: number): string {
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod10 === 1 && mod100 !== 11) return "чек";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "чека";
  return "чеков";
}

// Сотрудники по убыванию выручки за день. «Бигчек» — самый крупный одиночный
// чек дня среди всех кассиров отчёта, если он от 100 000 ₸: метка ставится
// ровно одному сотруднику (владельцу этого чека), не нескольким.
const BIG_CHECK_FROM = 100_000;

// Для недели и месяца (from < to) метка «бигчек» не ставится — отчёт за период
// только суммирует сотрудников.
async function buildEmployeeBlock(scope: ReportScope, from: string, to: string, withBigCheck = true): Promise<string> {
  const [empRes, regRes, demands] = await Promise.all([
    supabaseAdmin
      .from("moysklad_employee_sales_daily")
      .select("employee_ms_id, employee_name, revenue, receipts_count, items_count")
      .gte("sale_date", from)
      .lte("sale_date", to)
      .in("store", scope.cityCodes),
    supabaseAdmin.from("moysklad_registers").select("id").in("store", scope.cityCodes),
    withBigCheck ? fetchRetailDemandSummariesForDate(to) : Promise.resolve([]),
  ]);
  if (empRes.error) throw empRes.error;
  if (regRes.error) throw regRes.error;

  const byEmployee = new Map<string, { name: string; revenue: number; receipts: number; items: number }>();
  for (const r of (empRes.data ?? []) as {
    employee_ms_id: string;
    employee_name: string;
    revenue: number;
    receipts_count: number;
    items_count: number;
  }[]) {
    const agg = byEmployee.get(r.employee_ms_id) ?? { name: r.employee_name, revenue: 0, receipts: 0, items: 0 };
    agg.revenue += r.revenue;
    agg.receipts += r.receipts_count;
    agg.items += r.items_count;
    byEmployee.set(r.employee_ms_id, agg);
  }
  if (byEmployee.size === 0) return `<i>за ${from === to ? "день" : "период"} продаж нет</i>`;

  const registerIds = new Set((regRes.data ?? []).map((r) => r.id as string));
  let biggest: { sum: number; ownerId: string } | null = null;
  for (const d of demands) {
    if (!registerIds.has(d.retailStoreId)) continue;
    if (!biggest || d.sum > biggest.sum) biggest = { sum: d.sum, ownerId: d.ownerId };
  }
  const bigCheck = biggest && biggest.sum / 100 >= BIG_CHECK_FROM && byEmployee.has(biggest.ownerId) ? biggest : null;

  const lines = [...byEmployee.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([id, e], i) => {
      const mark = bigCheck && bigCheck.ownerId === id ? ` (бигчек ${num(bigCheck.sum / 100)})` : "";
      const avgCheck = e.receipts > 0 ? money(e.revenue / e.receipts) : "—";
      const depth = e.receipts > 0 ? (e.items / e.receipts).toFixed(2) : "—";
      return (
        `${i + 1}. ${e.name}${mark}\n   ${money(e.revenue)} · ${num(e.receipts)} ${checksWord(e.receipts)} · ${num(e.items)} шт` +
        `\n   ср.чек ${avgCheck} · глубина ${depth}`
      );
    });
  return pre(lines.join("\n"));
}

// Возвраты — как на сайте (Продажа): «сумма · N чек · N тов.», вычитаются из
// дня, когда произошёл сам возврат (выручка и чеки выше уже с их учётом).
// Итог по городу плюс те сотрудники, кто оформлял возврат.
function returnSummary(amount: number, receipts: number, items: number): string {
  const parts = [money(amount)];
  if (receipts > 0) parts.push(`${num(receipts)} чек`);
  if (items > 0) parts.push(`${num(items)} тов.`);
  return parts.join(" · ");
}

async function buildReturnsBlock(scope: ReportScope, from: string, to: string, dayRows: SalesRow[]): Promise<string> {
  const total = dayRows.reduce(
    (a, r) => ({
      amount: a.amount + (r.returned_amount ?? 0),
      receipts: a.receipts + (r.returned_receipts ?? 0),
      items: a.items + (r.returned_items ?? 0),
    }),
    { amount: 0, receipts: 0, items: 0 }
  );

  const { data, error } = await supabaseAdmin
    .from("moysklad_employee_sales_daily")
    .select("employee_ms_id, employee_name, returned_amount, returned_receipts, returned_items")
    .gte("sale_date", from)
    .lte("sale_date", to)
    .in("store", scope.cityCodes);
  if (error) throw error;

  const byEmployee = new Map<string, { name: string; amount: number; receipts: number; items: number }>();
  for (const r of (data ?? []) as {
    employee_ms_id: string;
    employee_name: string;
    returned_amount: number | null;
    returned_receipts: number | null;
    returned_items: number | null;
  }[]) {
    const amount = r.returned_amount ?? 0;
    const receipts = r.returned_receipts ?? 0;
    const items = r.returned_items ?? 0;
    if (amount === 0 && receipts === 0 && items === 0) continue;
    const agg = byEmployee.get(r.employee_ms_id) ?? { name: r.employee_name, amount: 0, receipts: 0, items: 0 };
    agg.amount += amount;
    agg.receipts += receipts;
    agg.items += items;
    byEmployee.set(r.employee_ms_id, agg);
  }

  if (total.amount === 0 && total.receipts === 0 && total.items === 0 && byEmployee.size === 0) {
    return `<i>за ${from === to ? "день" : "период"} возвратов нет</i>`;
  }

  const lines = [`Всего: ${returnSummary(total.amount, total.receipts, total.items)}`];
  const people = [...byEmployee.values()].sort((a, b) => b.amount - a.amount);
  if (people.length > 0) lines.push("");
  for (const e of people) lines.push(`${e.name}\n   ${returnSummary(e.amount, e.receipts, e.items)}`);
  return pre(lines.join("\n"));
}

function shortDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

// Недельный (7 дней, заканчивая `to`) и месячный (с 1-го числа месяца `to` по
// `to`) отчёт: те же разделы, что у дневного отчёта Актау, суммы за период, но
// без метки «бигчек». Для воскресенья/последнего дня месяца `to` = вчера.
export async function buildPeriodReport(scope: ReportScope, kind: "week" | "month", to: string): Promise<string[]> {
  const toDate = parseYmd(to);
  const fromDate = new Date(toDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  const from = kind === "week" ? ymd(fromDate) : `${to.slice(0, 8)}01`;

  const [rows, trafficRes] = await Promise.all([
    loadSales(scope, from, to),
    supabaseAdmin
      .from("traffic_entries")
      .select("traffic_plan, traffic_fact")
      .gte("entry_date", from)
      .lte("entry_date", to)
      .in("store", scope.cityCodes),
  ]);
  if (trafficRes.error) throw trafficRes.error;
  const visitors = (trafficRes.data ?? []).reduce((a, r) => a + (Number(r.traffic_fact) || 0), 0);
  const trafficPlan = (trafficRes.data ?? []).reduce((a, r) => a + (Number(r.traffic_plan) || 0), 0);
  const receipts = rows.reduce((a, r) => a + r.receipts_count, 0);

  const title = `📊 <b>Продажи · ${escapeHtml(scope.title)}</b>\n<i>${shortDate(from)} – ${shortDate(to)}</i>`;
  return packSections([
    title,
    section(kind === "week" ? "ИТОГИ НЕДЕЛИ" : "ИТОГИ МЕСЯЦА", kpiBlock(rows, visitors, true)),
    section("ПО СПОСОБУ ОПЛАТЫ", await paymentBlock(rows, from, to)),
    section("ПО СОТРУДНИКАМ", await buildEmployeeBlock(scope, from, to, false)),
    section("ВОЗВРАТЫ", await buildReturnsBlock(scope, from, to, rows)),
    section("ТРАФИК", trafficBlock(receipts, visitors, trafficPlan)),
    section("LTV", await ltvBlock(rows, from, to)),
  ]);
}

export async function buildSalesReport(scope: ReportScope, date: string): Promise<string[]> {
  const monthStart = `${date.slice(0, 8)}01`;
  const warehouses = warehousesForCities(scope.cityCodes);

  // Компактный отчёт (Актау) не показывает публикации, категории и топ товаров —
  // эти запросы для него не делаем.
  const skipped = { data: [] as never[], error: null };
  const [monthRows, trafficRes, pubRes, catRes, prodRes] = await Promise.all([
    loadSales(scope, monthStart, date),
    supabaseAdmin
      .from("traffic_entries")
      .select("traffic_plan, traffic_fact")
      .eq("entry_date", date)
      .in("store", scope.cityCodes),
    scope.compact
      ? skipped
      : supabaseAdmin
          .from("publication_entries")
          .select("entry_time, post_type, source, reach, views, likes, comments, shares, caption")
          .eq("entry_date", date)
          .in("store", scope.cityCodes)
          .order("entry_time", { ascending: true }),
    scope.compact ? skipped : supabaseAdmin.rpc("report_top_categories", { p_stores: warehouses, p_date: date, p_limit: 5 }),
    scope.compact
      ? skipped
      : supabaseAdmin.rpc("report_top_products", { p_stores: warehouses, p_date: date, p_days: 14, p_limit: 10 }),
  ]);
  if (trafficRes.error) throw trafficRes.error;
  if (pubRes.error) throw pubRes.error;
  if (catRes.error) throw catRes.error;
  if (prodRes.error) throw prodRes.error;

  const dayRows = monthRows.filter((r) => r.sale_date === date);
  const visitors = (trafficRes.data ?? []).reduce((a, r) => a + (Number(r.traffic_fact) || 0), 0);
  const trafficPlan = (trafficRes.data ?? []).reduce((a, r) => a + (Number(r.traffic_plan) || 0), 0);

  const title = `📊 <b>Продажи · ${escapeHtml(scope.title)}</b>\n<i>${dateLabel(date)}</i>`;

  const categories = (catRes.data ?? []) as { category: string; revenue: number; quantity: number; cost: number | null }[];
  const categoryBlock =
    categories.length === 0
      ? `<i>за день продаж нет</i>`
      : pre(
          table(
            ["Категория", "Выручка", "Шт", "Маржа"],
            categories.map((c) => [c.category, num(c.revenue), num(c.quantity), pct(c.revenue, c.cost)]),
            [16, 7, 3, 5],
            1
          )
        );

  const mtd = monthRows.reduce((a, r) => a + r.revenue, 0);
  const dayNumber = Number(date.slice(8, 10));
  const [yy, mm] = date.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const forecast = dayNumber > 0 ? (mtd / dayNumber) * daysInMonth : 0;
  const forecastBlock =
    pre(`${"С 1 числа".padEnd(14)}${money(mtd).padStart(18)}\n${"Прогноз".padEnd(14)}${money(forecast).padStart(18)}`) +
    `\n<i>по темпу ${dayNumber} дн. на ${daysInMonth}</i>`;

  const pubs = (pubRes.data ?? []) as {
    entry_time: string | null;
    post_type: string;
    source: string;
    reach: number;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    caption: string | null;
  }[];
  const pubLines = pubs.map((p) => {
    const head = `${p.entry_time ? p.entry_time.slice(0, 5) : "--:--"} · ${p.post_type === "reel" ? "рилс" : "пост"}${p.source === "ads" ? " (реклама)" : ""}`;
    const stats = `  охват ${num(p.reach)} · просмотры ${num(p.views)} · реакций ${num(p.likes + p.comments + p.shares)}`;
    const caption = p.caption ? `\n  ${fit(p.caption.replace(/\s+/g, " ").trim(), 32).trimEnd()}` : "";
    return `${head}\n${stats}${caption}`;
  });
  const publicationsBlock = pubs.length === 0 ? `<i>за день публикаций не внесено</i>` : pre(pubLines.join("\n"));

  const compact = !!scope.compact;
  const employeesBlock = compact ? await buildEmployeeBlock(scope, date, date) : null;
  const returnsBlock = compact ? await buildReturnsBlock(scope, date, date, dayRows) : null;
  const paymentsBlock = compact ? await paymentBlock(dayRows, date, date) : null;
  const ltvSection = compact ? await ltvBlock(dayRows, date, date) : null;
  const coreSections = [
    title,
    section("ИТОГИ ДНЯ", kpiBlock(dayRows, visitors, compact)),
    section(paymentsBlock ? "ПО СПОСОБУ ОПЛАТЫ" : "ПО КАССАМ", paymentsBlock ?? kassaBlock(dayRows, compact)),
    ...(employeesBlock ? [section("ПО СОТРУДНИКАМ", employeesBlock)] : []),
    ...(returnsBlock ? [section("ВОЗВРАТЫ", returnsBlock)] : []),
    ...(compact ? [] : [section("ТОП КАТЕГОРИЙ", categoryBlock)]),
    ...(compact ? [] : [section("ПРОГНОЗ МЕСЯЦА", forecastBlock)]),
    ...(compact
      ? [section("ТРАФИК", trafficBlock(dayRows.reduce((a, r) => a + r.receipts_count, 0), visitors, trafficPlan))]
      : []),
    ...(ltvSection ? [section("LTV", ltvSection)] : []),
  ];
  if (compact) return packSections(coreSections);

  const salesMessages = packSections([
    ...coreSections,
    section("INSTAGRAM", NOT_CONFIGURED),
    section("ПУБЛИКАЦИИ ДНЯ", publicationsBlock),
    section("РЕКЛАМА", NOT_CONFIGURED),
  ]);

  const products = (prodRes.data ?? []) as { article: string; quantity: number; revenue: number; day_quantity: number }[];
  const productsBlock =
    products.length === 0
      ? `<i>продаж за 14 дней нет</i>`
      : pre(
          table(
            ["Товар", "Шт", "Выручка", "Вчера"],
            products.map((p) => [p.article, num(p.quantity), num(p.revenue), p.day_quantity > 0 ? num(p.day_quantity) : "—"]),
            [14, 3, 7, 5],
            1,
            2
          )
        );
  const productMessages = packSections([
    `📦 <b>Товары · ${escapeHtml(scope.title)}</b>\n<i>${dateLabel(date)}</i>`,
    section("ТОП-10 ЗА 14 ДНЕЙ", productsBlock),
  ]);

  return [...salesMessages, ...productMessages];
}
