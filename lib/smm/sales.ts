// Продажи по категориям для бота СММ: общие продажи города (из таблицы продаж по товарам) и онлайн-продажи (чеки Болат Наргизы из МойСклад).
import { trim2 } from "@/lib/numFormat";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchRetailDemandsForOwner } from "@/lib/moysklad";
import { CITIES, ONLINE_SELLER, type CityKey } from "@/lib/smm/config";
import { periodLabel, type Period } from "@/lib/smm/periods";
import { escapeHtml } from "@/lib/telegram";

export type CategoryRow = { category: string; qty: number; revenue: number };
export type ProductRow = { category: string; name: string; qty: number; revenue: number };
export type SalesSource = "all" | "online";

export type CategoryReport = { rows: CategoryRow[]; totalQty: number; totalRevenue: number; checks?: number };

export async function categorySales(city: CityKey, p: Period): Promise<CategoryReport> {
  const { data, error } = await supabaseAdmin.rpc("smm_category_sales", { p_store: CITIES[city].store, p_from: p.from, p_to: p.to });
  if (error) throw error;
  const rows = ((data ?? []) as { category: string; qty: number | string; revenue: number | string }[]).map((r) => ({ category: r.category, qty: Number(r.qty), revenue: Number(r.revenue) })).filter((r) => r.qty > 0);
  return { rows, totalQty: rows.reduce((a, r) => a + r.qty, 0), totalRevenue: rows.reduce((a, r) => a + r.revenue, 0) };
}

export async function categoryProducts(city: CityKey, p: Period, categories: string[]): Promise<ProductRow[]> {
  const { data, error } = await supabaseAdmin.rpc("smm_category_products", { p_store: CITIES[city].store, p_from: p.from, p_to: p.to, p_categories: categories });
  if (error) throw error;
  return ((data ?? []) as { category: string; product_name: string; qty: number | string; revenue: number | string }[])
    .map((r) => ({ category: r.category, name: r.product_name, qty: Number(r.qty), revenue: Number(r.revenue) }))
    .filter((r) => r.qty > 0);
}

// ---- онлайн-продажи (чеки онлайн-продавца) ----

type OnlineItem = { productId: string; name: string; qty: number; revenue: number };

async function onlineItems(p: Period): Promise<{ checks: number; items: OnlineItem[] }> {
  const demands = await fetchRetailDemandsForOwner(ONLINE_SELLER.ms_id, p.from, p.to);
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
