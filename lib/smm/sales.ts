// Продажи по категориям для бота СММ: общие продажи города (из таблицы продаж по товарам) и онлайн-продажи (чеки Актау из МойСклад с отметкой «онлайн» в комментарии).
import { trim2 } from "@/lib/numFormat";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchOnlineCandidateDemands, fetchProfitByProductForDate } from "@/lib/moysklad";
import { WAREHOUSE_STORE } from "@/lib/warehouses";
import { addDays, todayInAlmaty } from "@/lib/coach/metrics";
import { REGISTER_STORE } from "@/lib/registers";
import { onlineOnly } from "@/lib/onlineCheck";
import { CITIES, type CityKey } from "@/lib/smm/config";
import { periodLabel, type Period } from "@/lib/smm/periods";
import { escapeHtml } from "@/lib/telegram";

export type CategoryRow = { category: string; qty: number; revenue: number };
export type ProductRow = { category: string; name: string; qty: number; revenue: number };
export type SalesSource = "all" | "online";

export type CategoryReport = { rows: CategoryRow[]; totalQty: number; totalRevenue: number; checks?: number };

// Таблица продаж по товарам пополняется ночью за вчера, сегодняшнего дня в ней нет. Поэтому, если период доходит до сегодня, сегодняшние продажи берём прямо из МойСклад
// тем же отчётом «Прибыль по товарам», что и ночное обновление (по складу города), а прошлые дни — из таблицы. Так «Сегодня» показывает продажи в реальном времени.
type LiveRow = { productId: string; name: string; qty: number; revenue: number; category: string };

async function liveToday(city: CityKey): Promise<LiveRow[]> {
  const warehouseId = Object.keys(WAREHOUSE_STORE).find((id) => WAREHOUSE_STORE[id] === CITIES[city].store);
  if (!warehouseId) return [];
  const rows = (await fetchProfitByProductForDate(todayInAlmaty(), warehouseId)).filter((r) => r.quantity !== 0);
  const cat = await topCategories(rows.map((r) => r.productMsId));
  return rows.map((r) => ({ productId: r.productMsId, name: r.name, qty: r.quantity, revenue: r.revenue, category: cat.get(r.productMsId) ?? "Без категории" }));
}

// Период для таблицы: без сегодняшнего дня (его добавляет liveToday). null — в таблице искать нечего.
function storedPeriod(p: Period): Period | null {
  const today = todayInAlmaty();
  if (p.to < today) return p;
  const to = addDays(today, -1);
  return p.from <= to ? { from: p.from, to } : null;
}

export async function categorySales(city: CityKey, p: Period): Promise<CategoryReport> {
  const stored = storedPeriod(p);
  const by = new Map<string, CategoryRow>();
  const add = (category: string, qty: number, revenue: number) => {
    const c = by.get(category) ?? { category, qty: 0, revenue: 0 };
    c.qty += qty;
    c.revenue += revenue;
    by.set(category, c);
  };
  if (stored) {
    const { data, error } = await supabaseAdmin.rpc("smm_category_sales", { p_store: CITIES[city].store, p_from: stored.from, p_to: stored.to });
    if (error) throw error;
    for (const r of (data ?? []) as { category: string; qty: number | string; revenue: number | string }[]) add(r.category, Number(r.qty), Number(r.revenue));
  }
  if (p.to >= todayInAlmaty() && p.from <= todayInAlmaty()) for (const r of await liveToday(city)) add(r.category, r.qty, r.revenue);
  const rows = [...by.values()].filter((r) => r.qty > 0).sort((a, b) => b.qty - a.qty);
  return { rows, totalQty: rows.reduce((a, r) => a + r.qty, 0), totalRevenue: rows.reduce((a, r) => a + r.revenue, 0) };
}

export async function categoryProducts(city: CityKey, p: Period, categories: string[]): Promise<ProductRow[]> {
  const stored = storedPeriod(p);
  const rows: ProductRow[] = [];
  const byName = new Map<string, ProductRow>(); // категория|название → строка: сегодняшние продажи дописываются к строке товара из таблицы
  const add = (category: string, name: string, qty: number, revenue: number, merge: boolean) => {
    const key = `${category}|${name}`;
    const r = merge ? byName.get(key) : undefined;
    if (r) {
      r.qty += qty;
      r.revenue += revenue;
      return;
    }
    const row = { category, name, qty, revenue };
    rows.push(row);
    if (!byName.has(key)) byName.set(key, row);
  };
  if (stored) {
    const { data, error } = await supabaseAdmin.rpc("smm_category_products", { p_store: CITIES[city].store, p_from: stored.from, p_to: stored.to, p_categories: categories });
    if (error) throw error;
    for (const r of (data ?? []) as { category: string; product_name: string; qty: number | string; revenue: number | string }[]) add(r.category, r.product_name, Number(r.qty), Number(r.revenue), false);
  }
  if (p.to >= todayInAlmaty() && p.from <= todayInAlmaty()) {
    for (const r of await liveToday(city)) if (categories.includes(r.category)) add(r.category, r.name, r.qty, r.revenue, true);
  }
  return rows.filter((r) => r.qty > 0).sort((a, b) => a.category.localeCompare(b.category, "ru") || b.qty - a.qty);
}

// ---- онлайн-продажи (чеки Актау с отметкой «онлайн» в комментарии) ----

type OnlineItem = { productId: string; name: string; qty: number; revenue: number };

async function onlineItems(p: Period): Promise<{ checks: number; items: OnlineItem[] }> {
  const demands = await onlineOnly((await fetchOnlineCandidateDemands(p.from, p.to)).filter((d) => REGISTER_STORE[d.retailStore?.id ?? ""] === "point_1"));
  const byProduct = new Map<string, OnlineItem>();
  for (const d of demands) {
    for (const pos of ((d.positions as { rows?: any[] } | undefined)?.rows ?? []) as any[]) {
      const id = String(pos.assortment?.id ?? "");
      if (!id) continue;
      const it = byProduct.get(id) ?? { productId: id, name: String(pos.assortment?.name ?? "Без названия"), qty: 0, revenue: 0 };
      const qty = Number(pos.quantity ?? 0);
      it.qty += qty;
      it.revenue += (Number(pos.price ?? 0) * qty * (1 - Number(pos.discount ?? 0) / 100)) / 100;
      byProduct.set(id, it);
    }
  }
  return { checks: demands.length, items: [...byProduct.values()] };
}

async function topCategories(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin.from("moysklad_products").select("id, top_category").in("id", ids.slice(i, i + 200));
    if (error) throw error;
    for (const r of (data ?? []) as { id: string; top_category: string | null }[]) out.set(r.id, r.top_category ?? "Без категории");
  }
  return out;
}

export async function onlineSales(p: Period): Promise<{ report: CategoryReport; products: ProductRow[] }> {
  const { checks, items } = await onlineItems(p);
  const cat = await topCategories(items.map((i) => i.productId));
  const products: ProductRow[] = items.map((i) => ({ category: cat.get(i.productId) ?? "Без категории", name: i.name, qty: i.qty, revenue: i.revenue })).filter((i) => i.qty > 0);
  const by = new Map<string, CategoryRow>();
  for (const r of products) {
    const c = by.get(r.category) ?? { category: r.category, qty: 0, revenue: 0 };
    c.qty += r.qty;
    c.revenue += r.revenue;
    by.set(r.category, c);
  }
  const rows = [...by.values()].sort((a, b) => b.qty - a.qty);
  return { report: { rows, totalQty: rows.reduce((a, r) => a + r.qty, 0), totalRevenue: rows.reduce((a, r) => a + r.revenue, 0), checks }, products };
}

export async function onlineProducts(p: Period, categories: string[]): Promise<ProductRow[]> {
  const { products } = await onlineSales(p);
  return products.filter((r) => categories.includes(r.category)).sort((a, b) => a.category.localeCompare(b.category, "ru") || b.qty - a.qty);
}

// ---- оформление ----

export const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");
const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : trim2(n));
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

// 5 категорий с наибольшими продажами; остальные — одной строкой «Прочее». all=true — все категории подряд.
export function categoryLines(rows: CategoryRow[], total: number, all = false): { lines: string[]; hasRest: boolean } {
  const top = all ? rows : rows.slice(0, 5);
  const rest = all ? [] : rows.slice(5);
  const lines = top.map((r) => `• ${escapeHtml(r.category)} — ${qtyText(r.qty)} шт · ${pct(r.qty, total)}%`);
  if (rest.length > 0) {
    const q = rest.reduce((a, r) => a + r.qty, 0);
    lines.push(`• Прочее — ${qtyText(q)} шт · ${pct(q, total)}%`);
  }
  return { lines, hasRest: rest.length > 0 };
}

export function categoryMessage(city: CityKey, p: Period, report: CategoryReport, kind: SalesSource, all = false): { text: string; hasRest: boolean } {
  const head = kind === "online" ? `🛒 <b>Онлайн-продажи · ${CITIES[city].title}</b>` : `🛍 <b>Продажи по категориям · ${CITIES[city].title}</b>`;
  if (report.rows.length === 0) return { text: `${head}\n${periodLabel(p)}\nПродаж нет.`, hasRest: false };
  const { lines, hasRest } = categoryLines(report.rows, report.totalQty, all);
  const tail = kind === "online" ? `\nЧеков: ${report.checks ?? 0} · товаров ${qtyText(report.totalQty)} шт · ${fmt(report.totalRevenue)} ₸` : `\nВсего ${qtyText(report.totalQty)} шт · ${fmt(report.totalRevenue)} ₸`;
  return { text: `${head}\n${periodLabel(p)}\n\n${lines.join("\n")}${tail}`, hasRest };
}

export function productsMessage(city: CityKey, p: Period, kind: SalesSource, products: ProductRow[]): string {
  const head = `📋 <b>${kind === "online" ? "Онлайн-продажи" : "Товары"} · ${CITIES[city].title}</b>\n${periodLabel(p)}`;
  if (products.length === 0) return `${head}\n\nПо выбранным категориям продаж нет.`;
  const lines: string[] = [];
  let current = "";
  for (const r of products) {
    if (r.category !== current) {
      current = r.category;
      lines.push(`\n<b>${escapeHtml(current)}</b>`);
    }
    lines.push(`• ${escapeHtml(r.name)} — ${qtyText(r.qty)} шт · ${fmt(r.revenue)} ₸`);
  }
  return `${head}\n${lines.join("\n")}`;
}
