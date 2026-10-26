// АВС/XYZ за период для PDF: тот же расчёт, что на странице «Склад → АВС/XYZ» (артикулы с оборотом за период; A — верхние 80 % оборота,
// B — следующие 15 %, C — остальные 5 %; X — продажи более чем в 60 % дней периода, Y — от 20 %, Z — реже). Склады — все склады города.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { warehousesForCities } from "@/lib/warehouses";
import type { PdfSection } from "@/lib/exportPdf";

type AbcKey = "A" | "B" | "C";
type XyzKey = "X" | "Y" | "Z";
export type AbcRow = { name: string; category: string; revenue: number; quantity: number; cost: number; daysWithSales: number; abc: AbcKey; xyz: XyzKey };
export type AbcData = { days: number; rows: AbcRow[] };

const DECISIONS: Record<string, string> = {
  AX: "лидер, стабильный спрос — держать в наличии всегда",
  AY: "важен, спрос скачет — держать страховой запас",
  AZ: "деньги редкими вспышками — заказывать точечно, под всплеск",
  BX: "стабильный, средний вклад — поддерживать наличие",
  BY: "средний, неровный спрос — заказывать чаще малыми партиями",
  BZ: "редкий спрос — заказывать под конкретный заказ",
  CX: "низкий вклад, но стабилен — держать минимальный запас",
  CY: "низкий вклад, неровный спрос — не приоритет для закупки",
  CZ: "почти не продаётся — кандидат на исключение из ассортимента",
};
const ABC_KEYS: AbcKey[] = ["A", "B", "C"];
const XYZ_LABELS: { key: XyzKey; label: string }[] = [
  { key: "X", label: "X — стабильно" },
  { key: "Y", label: "Y — неровно" },
  { key: "Z", label: "Z — редко" },
];

const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ")} ₸`;
const int = (n: number) => Number(n).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ");

export async function loadAbcXyz(city: string, from: string, to: string): Promise<AbcData> {
  const stores = warehousesForCities([city]);
  type Raw = { article: string; category: string | null; revenue: number; quantity: number; cost: number; days_with_sales: number };
  const raw: Raw[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.rpc("product_sales_summary_by_article", { p_from: from, p_to: to, p_stores: stores }).range(offset, offset + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Raw[];
    raw.push(...rows);
    if (rows.length < 1000) break;
  }
  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
  // Только артикулы с настоящим оборотом за период: без продаж (или только возвраты) — это «Зависшие остатки».
  const withRevenue = raw.map((r) => ({ ...r, revenue: Number(r.revenue), quantity: Number(r.quantity), cost: Number(r.cost), days_with_sales: Number(r.days_with_sales) })).filter((r) => r.revenue > 0);
  withRevenue.sort((a, b) => b.revenue - a.revenue || a.article.localeCompare(b.article, "ru"));
  const totalRevenue = withRevenue.reduce((a, r) => a + r.revenue, 0);
  let cumulative = 0;
  const rows = withRevenue.map((r): AbcRow => {
    cumulative += r.revenue;
    const share = totalRevenue > 0 ? cumulative / totalRevenue : 1;
    const coverage = r.days_with_sales / days;
    return {
      name: r.article,
      category: r.category ?? "Без категории",
      revenue: r.revenue,
      quantity: r.quantity,
      cost: r.cost,
      daysWithSales: r.days_with_sales,
      abc: share <= 0.8 ? "A" : share <= 0.95 ? "B" : "C",
      xyz: coverage > 0.6 ? "X" : coverage >= 0.2 ? "Y" : "Z",
    };
  });
  return { days, rows };
}

export function abcXyzSections(data: AbcData): PdfSection[] {
  const matrix = Object.fromEntries(ABC_KEYS.map((a) => [a, { X: { count: 0, revenue: 0 }, Y: { count: 0, revenue: 0 }, Z: { count: 0, revenue: 0 } }])) as Record<AbcKey, Record<XyzKey, { count: number; revenue: number }>>;
  for (const r of data.rows) {
    matrix[r.abc][r.xyz].count += 1;
    matrix[r.abc][r.xyz].revenue += r.revenue;
  }
  return [
    {
      title: `АВС/XYZ — матрица (дней в периоде: ${data.days})`,
      note: "АВС — доля в обороте: A — верхние 80 %, B — 15 %, C — 5 %. XYZ — ровность спроса по дням с продажами.",
      headers: ["", ...XYZ_LABELS.map((x) => x.label)],
      align: ["left", "right", "right", "right"],
      widths: [0.6, 1.4, 1.4, 1.4],
      rows: ABC_KEYS.map((a) => [a, ...XYZ_LABELS.map((x) => `${matrix[a][x.key].count} поз · ${money(matrix[a][x.key].revenue)}`)]),
    },
    {
      title: `АВС/XYZ — позиции (${data.rows.length.toLocaleString("ru-RU")})`,
      headers: ["Артикул", "Категория", "ABC", "XYZ", "Оборот", "Штук", "Дней", "Валовый %", "Решение"],
      align: ["left", "left", "center", "center", "right", "right", "right", "right", "left"],
      widths: [2.6, 1.5, 0.5, 0.5, 1.4, 0.8, 0.6, 0.9, 3.2],
      rows: data.rows.map((r) => [r.name, r.category, r.abc, r.xyz, money(r.revenue), int(r.quantity), r.daysWithSales, `${(r.revenue !== 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0).toFixed(0)}%`, DECISIONS[`${r.abc}${r.xyz}`] ?? ""]),
    },
  ];
}
