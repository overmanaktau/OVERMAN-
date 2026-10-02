import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { warehousesForCities } from "@/lib/warehouses";
import { escapeHtml, packSections } from "@/lib/telegram";

// compact: укороченный формат — без маржи, Instagram, публикаций, рекламы и
// топа товаров, зато с количеством товара в итогах дня. Пока только у Актау;
// остальные отчёты остаются полными, пока пользователь не скажет их править.
export type ReportScope = { key: string; title: string; cityCodes: string[]; compact?: boolean };

// cityCodes are the city-level codes (point_1/point_3) moysklad_sales_daily,
// traffic_entries and publication_entries use; the per-warehouse codes the
// product tables use come from warehousesForCities.
export const SCOPES: Record<string, ReportScope> = {
  point_1: { key: "point_1", title: "Overman Актау", cityCodes: ["point_1"], compact: true },
  point_3: { key: "point_3", title: "Overman Актобе", cityCodes: ["point_3"] },
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
function pre(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
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
  revenue: number;
  receipts_count: number;
  items_count: number;
  cost: number | null;
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
    .select("revenue, receipts_count, items_count, cost, sale_date, moysklad_registers(name, store)")
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
        conversion,
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

export async function buildSalesReport(scope: ReportScope, date: string): Promise<string[]> {
  const monthStart = `${date.slice(0, 8)}01`;
  const warehouses = warehousesForCities(scope.cityCodes);

  const [monthRows, trafficRes, pubRes, catRes, prodRes] = await Promise.all([
    loadSales(scope, monthStart, date),
    supabaseAdmin.from("traffic_entries").select("traffic_fact").eq("entry_date", date).in("store", scope.cityCodes),
    supabaseAdmin
      .from("publication_entries")
      .select("entry_time, post_type, source, reach, views, likes, comments, shares, caption")
      .eq("entry_date", date)
      .in("store", scope.cityCodes)
      .order("entry_time", { ascending: true }),
    supabaseAdmin.rpc("report_top_categories", { p_stores: warehouses, p_date: date, p_limit: 5 }),
    supabaseAdmin.rpc("report_top_products", { p_stores: warehouses, p_date: date, p_days: 14, p_limit: 10 }),
  ]);
  if (trafficRes.error) throw trafficRes.error;
  if (pubRes.error) throw pubRes.error;
  if (catRes.error) throw catRes.error;
  if (prodRes.error) throw prodRes.error;

  const dayRows = monthRows.filter((r) => r.sale_date === date);
  const visitors = (trafficRes.data ?? []).reduce((a, r) => a + (Number(r.traffic_fact) || 0), 0);

  const title = `📊 <b>Продажи · ${escapeHtml(scope.title)}</b>\n<i>${dateLabel(date)}</i>`;

  const categories = (catRes.data ?? []) as { category: string; revenue: number; quantity: number; cost: number | null }[];
  const categoryBlock =
    categories.length === 0
      ? `<i>за день продаж нет</i>`
      : scope.compact
        ? pre(
            table(
              ["Категория", "Выручка", "Шт"],
              categories.map((c) => [c.category, num(c.revenue), num(c.quantity)]),
              [18, 9, 3],
              1
            )
          )
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
  const coreSections = [
    title,
    section("ИТОГИ ДНЯ", kpiBlock(dayRows, visitors, compact)),
    section("ПО КАССАМ", kassaBlock(dayRows, compact)),
    section("ТОП КАТЕГОРИЙ", categoryBlock),
    section("ПРОГНОЗ МЕСЯЦА", forecastBlock),
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
