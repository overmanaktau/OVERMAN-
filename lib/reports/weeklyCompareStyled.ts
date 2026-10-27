// Оформление PDF «Сравнение недель / периодов» — «тепловая карта»: тёмная шапка, ячейки подсвечены (выполнение плана и средний чек —
// зелёный / жёлтый / красный, оборот, посетители и конверсия — по силе дня), разница окрашена. Данные и расчёты — в weeklyCompare.ts.
import { trim2 } from "@/lib/numFormat";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { MONTH, dec, int, loadFonts, pct, ratios, signed, sumDays, weekdayOf, weekOfMonth, type CompareLabels, type CompareWeek } from "@/lib/reports/weeklyCompare";

type RGB = [number, number, number];
const C = {
  ink: [28, 26, 23] as RGB,
  muted: [91, 85, 72] as RGB,
  light: [140, 133, 119] as RGB,
  paper: [246, 243, 238] as RGB,
  stripe: [251, 249, 244] as RGB,
  accentSoft: [228, 236, 230] as RGB,
  green: [38, 120, 78] as RGB,
  red: [176, 70, 48] as RGB,
  greenBg: [214, 236, 221] as RGB,
  redBg: [246, 218, 210] as RGB,
  yellowBg: [250, 238, 196] as RGB,
  white: [255, 255, 255] as RGB,
};

type Cell = string | { content: string; colSpan?: number; rowSpan?: number; styles?: Record<string, unknown> };

// Посетители: целое — без дробной части, иначе два знака после запятой
const vis = (n: number) => (Number.isInteger(Math.round(n * 100) / 100) ? int(n) : dec(n, 2));
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const span = (w: CompareWeek) => `${dm(w.from)}–${dm(w.to)}`;
const rel = (a: number, b: number): number | null => (a > 0 ? ((b - a) / a) * 100 : null);
const relText = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${trim2(Math.abs(v), ",")}%`);
const tone = (v: number | null): RGB => (v === null || Math.abs(v) < 0.05 ? C.muted : v > 0 ? C.green : C.red);
const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

const FOOT = "План оборота — дневной план города: план месяца по периодам раздела «Продажа», разложенный по дням недели (в выходные больше). План посетителей — из «Статистики». Оборот с учётом возвратов. Конверсия = чеки ÷ посетители, глубина = товары ÷ чеки.";

export async function buildStyledComparePdf(weeks: [CompareWeek, CompareWeek], city: string, custom?: CompareLabels): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  pdf.addFileToVFS("NotoSans-Regular.ttf", fonts.regular);
  pdf.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  pdf.addFileToVFS("NotoSans-Bold.ttf", fonts.bold);
  pdf.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");

  const wi = [weekOfMonth(weeks[0].from), weekOfMonth(weeks[1].from)];
  const totals = weeks.map((w) => sumDays(w.days));
  const r = totals.map(ratios);
  const label = (i: number) => (custom ? custom.bands[i] : `${wi[i].n} неделя · ${MONTH[wi[i].month]}`);
  const short = (i: number) => `${wi[i].n} нед. ${["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"][wi[i].month]}`;
  const dayLabel = (d: string) => (custom?.dayAsDate ? dm(d) : String(Number(d.slice(8, 10))));

  // ── шапка
  pdf.setFillColor(...C.ink);
  pdf.rect(0, 0, 297, 17, "F");
  pdf.setFont("NotoSans", "bold");
  pdf.setFontSize(13);
  pdf.setTextColor(...C.white);
  pdf.text(custom?.title ?? `Сравнение недель · ${city}`, 10, 8);
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(8.2);
  pdf.setTextColor(210, 204, 190);
  pdf.text(custom?.subtitle ?? `${label(0)} (${span(weeks[0])})   →   ${label(1)} (${span(weeks[1])})`, 10, 13);
  pdf.setFontSize(7);
  pdf.text("% плана: зелёный — выполнен · жёлтый — 80–99% · красный — меньше 80%", 287, 8, { align: "right" });
  pdf.text("средний чек: зелёный — выше среднего за два периода на 5%+ · жёлтый — в пределах 5% · красный — ниже на 5%+", 287, 13, { align: "right" });

  // ── шкалы подсветки
  const all = weeks.flatMap((w) => w.days);
  const maxRev = Math.max(...all.map((x) => x.revenue), 1);
  const maxVis = Math.max(...all.map((x) => x.visitors), 1);
  const allReceipts = all.reduce((acc, x) => acc + x.receipts, 0);
  const refAtv = allReceipts > 0 ? all.reduce((acc, x) => acc + x.revenue, 0) / allReceipts : 0;
  const atvFill = (v: number): RGB => (refAtv <= 0 ? C.stripe : v >= refAtv * 1.05 ? C.greenBg : v <= refAtv * 0.95 ? C.redBg : C.yellowBg);
  const planFill = (v: number | null): RGB | null => (v === null ? null : v >= 100 ? C.greenBg : v >= 80 ? C.yellowBg : C.redBg);

  const head = ["Число", "День", "Оборот\nплан", "Посетит.\nплан", "Оборот\nфакт", "Посетители", "Чеки", "Товары", "Средний\nчек", "Оборот,\n% плана", "Посетит.,\n% плана", "CR", "Глубина"];
  type Meta = { kind: "band" | "day" | "total" | "diff"; day?: ReturnType<typeof sumDays> };
  const metas: Meta[] = [];
  const body: Cell[][] = [];
  const cells = (lbl: string, wd: string, t: ReturnType<typeof sumDays>): string[] => {
    const q = ratios(t);
    return [lbl, wd, t.planRevenue > 0 ? int(t.planRevenue) : "—", t.planTraffic > 0 ? int(t.planTraffic) : "—", int(t.revenue), vis(t.visitors), int(t.receipts), int(t.items), int(q.atv), q.revPct === null ? "—" : pct(q.revPct, 1), q.trafPct === null ? "—" : pct(q.trafPct, 1), pct(q.cr, 2), dec(q.depth, 2)];
  };
  weeks.forEach((w, i) => {
    body.push([{ content: custom ? label(i) : `${label(i)}   ·   ${span(w)}`, colSpan: 13 }]);
    metas.push({ kind: "band" });
    for (const day of w.days) {
      const t = sumDays([day]);
      body.push(cells(dayLabel(day.date), weekdayOf(day.date), t));
      metas.push({ kind: "day", day: t });
    }
    body.push(cells("итог", "", totals[i]).map((c, k) => (k === 0 ? { content: "Итого", colSpan: 2 } : c)).filter((_, k) => k !== 1) as Cell[]);
    metas.push({ kind: "total", day: totals[i] });
  });

  // ── разница: цифра и %
  const [t1, t2] = totals;
  const [r1, r2] = r;
  const pairs: [number | null, number | null][] = [
    [t1.planRevenue || null, t2.planRevenue || null],
    [t1.planTraffic || null, t2.planTraffic || null],
    [t1.revenue, t2.revenue],
    [t1.visitors, t2.visitors],
    [t1.receipts, t2.receipts],
    [t1.items, t2.items],
    [r1.atv, r2.atv],
    [r1.revPct, r2.revPct],
    [r1.trafPct, r2.trafPct],
    [r1.cr, r2.cr],
    [r1.depth, r2.depth],
  ];
  const diffNum = pairs.map(([a, b], i) => (a === null || b === null ? "—" : i >= 7 && i <= 9 ? "" : signed(b - a, i === 10 ? (x) => dec(x, 2) : i === 3 ? vis : int)));
  const diffPct = pairs.map(([a, b]) => (a === null || b === null ? null : rel(a, b)));
  const diffCell = (i: number, txt: string): Cell => ({ content: txt, styles: { fillColor: diffPct[i] === null ? C.paper : diffPct[i]! >= 0 ? C.greenBg : C.redBg, textColor: tone(diffPct[i]), fontStyle: "bold" } });
  const diffLabel = custom ? custom.diff : `Разница: ${short(1)} от ${short(0)}`;
  body.push([{ content: diffLabel, colSpan: 2, rowSpan: 2, styles: { fillColor: C.ink, textColor: C.white, fontStyle: "bold" } }, ...(diffNum.map((n, i) => (i >= 7 && i <= 9 ? { ...(diffCell(i, relText(diffPct[i])) as object), rowSpan: 2 } : diffCell(i, n))) as Cell[])]);
  metas.push({ kind: "diff" });
  body.push(diffPct.map((p, i) => diffCell(i, relText(p))).filter((_, i) => !(i >= 7 && i <= 9)));
  metas.push({ kind: "diff" });

  autoTable(pdf, {
    startY: 21,
    head: [head],
    body: body as never,
    theme: "plain",
    margin: { left: 10, right: 10, top: 8, bottom: 12 },
    tableWidth: 277,
    styles: { font: "NotoSans", fontSize: 8, cellPadding: { top: 1.3, bottom: 1.3, left: 1.4, right: 1.4 }, halign: "center", valign: "middle", textColor: C.ink, lineColor: [255, 255, 255], lineWidth: 0.35 },
    headStyles: { fillColor: C.ink, textColor: C.white, fontStyle: "bold", fontSize: 7.2, lineColor: [255, 255, 255], lineWidth: 0.35 },
    columnStyles: { 0: { cellWidth: 14 }, 1: { cellWidth: 14 } },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const m = metas[data.row.index];
      const col = data.column.index;
      if (!m) return;
      if (m.kind === "band") {
        data.cell.styles.fillColor = C.paper;
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.halign = "left";
        data.cell.styles.fontSize = 9;
        return;
      }
      if (m.kind === "total") {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.fillColor = C.accentSoft;
        const q = ratios(m.day!);
        const f = col === 9 ? planFill(q.revPct) : col === 10 ? planFill(q.trafPct) : null;
        if (f) data.cell.styles.fillColor = f;
        if (col === 8 && m.day!.receipts > 0) data.cell.styles.fillColor = atvFill(q.atv);
        return;
      }
      if (m.kind !== "day" || !m.day) return;
      const q = ratios(m.day);
      if (col === 4) data.cell.styles.fillColor = mix(C.white, [185, 214, 196], m.day.revenue / maxRev);
      else if (col === 5) data.cell.styles.fillColor = mix(C.white, [196, 208, 232], m.day.visitors / maxVis);
      else if (col === 8 && m.day.receipts > 0) data.cell.styles.fillColor = atvFill(q.atv);
      else if (col === 9) data.cell.styles.fillColor = planFill(q.revPct) ?? C.stripe;
      else if (col === 10) data.cell.styles.fillColor = planFill(q.trafPct) ?? C.stripe;
      else if (col === 11) data.cell.styles.fillColor = mix(C.white, [236, 214, 168], Math.min(q.cr / 40, 1));
      if (col === 9 || col === 10 || col === 4 || col === 8) data.cell.styles.fontStyle = "bold";
    },
    didDrawPage: (data) => {
      // со второй страницы (длинные периоды) — тонкая тёмная полоса сверху
      if (data.pageNumber > 1) {
        pdf.setFillColor(...C.ink);
        pdf.rect(0, 0, 297, 6, "F");
        pdf.setFont("NotoSans", "bold");
        pdf.setFontSize(7.5);
        pdf.setTextColor(...C.white);
        pdf.text(custom?.title ?? `Сравнение недель · ${city}`, 10, 4.1);
      }
    },
  });

  // подпись внизу последней страницы и номера страниц
  const pages = pdf.getNumberOfPages();
  pdf.setPage(pages);
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(6.8);
  pdf.setTextColor(...C.light);
  pdf.text(pdf.splitTextToSize(FOOT, 240) as string[], 10, 201.5);
  if (pages > 1) {
    for (let i = 1; i <= pages; i++) {
      pdf.setPage(i);
      pdf.setFontSize(7);
      pdf.setTextColor(...C.light);
      pdf.text(`Страница ${i} из ${pages}`, 287, 205, { align: "right" });
    }
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}
