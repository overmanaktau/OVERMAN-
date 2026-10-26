// PDF-отчёты закупщика, которые он запрашивает кнопками в боте: «ABC/XYZ» и «Проданные товары» (отчёт «Отчёт» — warehouseOverview.ts).
// Только два основных склада (buyerStores.ts); поставщики — те, что закупщик отметил галочками (null — все).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildPdf, type PdfDoc } from "@/lib/exportPdf";
import { loadPdfFonts } from "@/lib/reports/pdfFonts";
import { abcXyzSections, loadAbcXyz } from "@/lib/reports/abcXyz";
import { BUYER_CITY_TITLE, BUYER_STORES } from "@/lib/reports/buyerStores";
import { ruPeriod } from "@/lib/fileNames";

const sp = (s: string) => s.replace(/[  ]/g, " ");
const int = (n: number) => sp(Math.round(n).toLocaleString("ru-RU"));
const money = (n: number) => `${int(n)} ₸`;
const ruDate = (iso: string) => iso.split("-").reverse().join(".");

function periodLine(title: string, from: string, to: string, suppliers: string[] | null, allSuppliers: number): string {
  const sup = suppliers === null ? "все поставщики" : `поставщиков: ${suppliers.length} из ${allSuppliers}`;
  return `${title}: ${ruDate(from)} — ${ruDate(to)} · ${sup}`;
}

// Какие поставщики выбраны — отдельной строкой под заголовком (когда выбраны не все).
function supplierMeta(suppliers: string[] | null): string[] {
  return suppliers === null ? [] : [`Поставщики: ${suppliers.join(", ")}`];
}

export function buyerFileName(kind: "abc" | "sold", city: string, from: string, to: string): string {
  return `${kind === "abc" ? "АВС-XYZ" : "Проданные товары"} ${BUYER_CITY_TITLE[city] ?? city} ${ruPeriod(from, to)}.pdf`;
}

export async function buildAbcPdfFor(city: string, from: string, to: string, suppliers: string[] | null, allSuppliers: number, periodTitle: string): Promise<Uint8Array> {
  const stores = BUYER_STORES[city];
  const data = await loadAbcXyz(stores, from, to, suppliers);
  const total = data.rows.reduce((a, r) => a + r.revenue, 0);
  const doc: PdfDoc = {
    fileName: `АВС-XYZ ${BUYER_CITY_TITLE[city]} ${ruPeriod(from, to)}`,
    title: `АВС/XYZ анализ · ${BUYER_CITY_TITLE[city]}`,
    subtitle: periodLine(periodTitle, from, to, suppliers, allSuppliers),
    meta: [...supplierMeta(suppliers), "АВС — доля в обороте: A — верхние 80 %, B — 15 %, C — 5 %", "XYZ — ровность спроса по дням с продажами"],
    orientation: "landscape",
    kpis: [
      { label: "Позиций", value: int(data.rows.length) },
      { label: "Оборот", value: money(total) },
    ],
    sections: abcXyzSections(data),
  };
  return new Uint8Array(buildPdf(doc, await loadPdfFonts()).output("arraybuffer"));
}

type SoldRow = { article: string; category: string | null; supplier_name: string | null; quantity: number; revenue: number; cost: number; stock_qty_end: number };

export async function buildSoldPdfFor(city: string, from: string, to: string, suppliers: string[] | null, allSuppliers: number, periodTitle: string): Promise<Uint8Array> {
  const stores = BUYER_STORES[city];
  const rows: SoldRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.rpc("buyer_sold_products", { p_stores: stores, p_from: from, p_to: to, p_suppliers: suppliers }).range(offset, offset + 999);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as SoldRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const list = rows.map((r) => ({ ...r, quantity: Number(r.quantity), revenue: Number(r.revenue), cost: Number(r.cost), stock_qty_end: Number(r.stock_qty_end) })).sort((a, b) => b.revenue - a.revenue || a.article.localeCompare(b.article, "ru"));
  const sum = list.reduce((a, r) => ({ q: a.q + r.quantity, rev: a.rev + r.revenue, cost: a.cost + r.cost, st: a.st + r.stock_qty_end }), { q: 0, rev: 0, cost: 0, st: 0 });
  const body: (string | number)[][] = list.map((r) => [r.article, r.category ?? "—", r.supplier_name ?? "—", int(r.quantity), money(r.cost), money(r.revenue), int(r.stock_qty_end)]);
  body.push(["Итого", "", "", int(sum.q), money(sum.cost), money(sum.rev), int(sum.st)]);
  const doc: PdfDoc = {
    fileName: `Проданные товары ${BUYER_CITY_TITLE[city]} ${ruPeriod(from, to)}`,
    title: `Проданные товары · ${BUYER_CITY_TITLE[city]}`,
    subtitle: periodLine(periodTitle, from, to, suppliers, allSuppliers),
    meta: [
      ...supplierMeta(suppliers),
      "Оборот по себестоимости — себестоимость проданного; по продажной цене — выручка за период",
      "Остаток — штук на последний день периода (по артикулу, все размеры); за прошедшие периоды восстановлен по документам, возможна небольшая погрешность из-за списаний",
    ],
    orientation: "landscape",
    kpis: [
      { label: "Артикулов", value: int(list.length) },
      { label: "Продано", value: `${int(sum.q)} шт` },
      { label: "Оборот по себестоимости", value: money(sum.cost) },
      { label: "Оборот по продажной цене", value: money(sum.rev) },
      { label: "Остаток", value: `${int(sum.st)} шт` },
    ],
    sections: [
      {
        title: `Проданные товары — ${int(list.length)} артикулов`,
        headers: ["Артикул / название", "Категория", "Поставщик", "Продано, шт", "Оборот по себестоимости", "Оборот по продажной цене", "Остаток, шт"],
        align: ["left", "left", "left", "right", "right", "right", "right"],
        widths: [3.2, 1.7, 1.5, 0.9, 1.5, 1.5, 0.9],
        rows: body,
        rowKinds: body.map((_, i) => (i === body.length - 1 ? ("total" as const) : ("normal" as const))),
      },
    ],
  };
  return new Uint8Array(buildPdf(doc, await loadPdfFonts()).output("arraybuffer"));
}
