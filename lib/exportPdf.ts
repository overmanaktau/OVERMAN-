import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { trim2Ru } from "@/lib/numFormat";

// Единая выгрузка в PDF для всех разделов портала. Оформление в цветах портала:
// тёплая бумага, глубокий зелёный акцент, мягкая зебра в таблицах, крупные итоги,
// колонтитул с номером страницы. Шрифты (Noto Sans и Noto Serif) лежат в
// public/fonts/pdf — в них есть кириллица, казахские буквы и знак тенге.

// Данные, которые в окне «Что скачать» скрываются одной галочкой: себестоимость и прибыль, конверсия.
export type PdfGroup = "cost" | "conversion";

export type PdfRowKind = "normal" | "group" | "sub" | "total";

export type PdfSection = {
  title?: string;
  note?: string;
  headers: string[];
  rows: (string | number)[][];
  align?: ("left" | "right" | "center")[]; // по колонкам; по умолчанию первая слева, остальные справа
  widths?: number[]; // относительные ширины колонок (необязательно)
  rowKinds?: PdfRowKind[]; // оформление строк: подгруппа, итог
  // двухэтажная шапка: группа без subs занимает оба этажа (обычно первая колонка), группа с subs — объединяет span колонок и показывает под собой подписи subs
  headGroups?: { label: string; span: number; subs?: string[] }[];
  fontSize?: number; // размер текста таблицы (по умолчанию 8.4) — для широких таблиц
  grid?: boolean; // контуры: линии между всеми ячейками, группы колонок отделены жирнее
  signColors?: boolean; // ячейки, начинающиеся с «+» / «−», красятся зелёным / красным (разница к прошлому периоду)
  softRed?: boolean[][]; // по строкам и колонкам: ячейки, выделяемые лёгким красным (например, валовый % ниже 50)
  indent?: number[]; // отступ первой колонки (уровень вложенности) по строкам
  // — для окна «Что скачать» (PdfButton): —
  optional?: boolean; // по умолчанию не отмечена (например, краткая сводка рядом с подробной)
  hint?: string; // пояснение под названием в окне выбора
  levelLabels?: string[]; // названия уровней детализации: «Только поставщики», «+ артикулы», …
  group?: PdfGroup; // вся таблица относится к группе (например, оборачиваемость — себестоимость)
  groupCols?: Partial<Record<PdfGroup, number[]>>; // номера колонок, относящихся к группе
  pickLabels?: string[]; // подписи строк для списка выбора в окне (по строкам таблицы): «Город · Актау», «Касса · Актау»
  units?: string[]; // для load: названия основных строк (чтобы в окне можно было выбрать нужные)
  filters?: { dates?: boolean; query?: string }; // для load: поля «с даты / по дату» и поиск (query — подпись поля)
  load?: (opts: { skip: Set<number>; from?: string; to?: string; query?: string }) => Promise<PdfSection>; // подгрузить строки, только если блок выбран; skip — номера снятых основных строк
};

export type PdfDoc = {
  fileName: string; // без .pdf
  title: string;
  subtitle?: string; // период, фильтры
  meta?: string[]; // мелкие подписи под заголовком
  kpis?: { label: string; value: string; note?: string; group?: PdfGroup }[]; // group: карточка скрывается галочкой своей группы
  sections: PdfSection[];
  orientation?: "portrait" | "landscape";
  author?: string | null;
};

export type PdfFonts = { regular: string; bold: string; serif: string }; // base64 TTF

const C = {
  ink: [28, 26, 23] as [number, number, number],
  muted: [91, 85, 72] as [number, number, number],
  mutedLight: [140, 133, 119] as [number, number, number],
  border: [228, 223, 214] as [number, number, number],
  soft: [239, 235, 226] as [number, number, number],
  paper: [246, 243, 238] as [number, number, number],
  stripe: [251, 249, 244] as [number, number, number],
  accent: [47, 74, 60] as [number, number, number],
  accentSoft: [228, 236, 230] as [number, number, number],
  tan: [184, 149, 106] as [number, number, number],
  greenBg: [214, 236, 221] as [number, number, number],
  redBg: [246, 218, 210] as [number, number, number],
  green: [38, 120, 78] as [number, number, number],
  red: [176, 70, 48] as [number, number, number],
};

// В шрифтах нет стрелок и геометрических фигур — заменяем на то, что точно есть.
function clean(v: string | number): string {
  if (typeof v === "number") return Number.isFinite(v) ? trim2Ru(v).replace(/\u00a0|\u202f/g, " ") : "";
  return String(v)
    .replace(/[→⟶]/g, "—")
    .replace(/↔/g, "/")
    .replace(/[▸▾▲▼◂]/g, "")
    .replace(/ /g, " ");
}

function nowAlmaty(): string {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildPdf(doc: PdfDoc, fonts: PdfFonts): jsPDF {
  const pdf = new jsPDF({ orientation: doc.orientation ?? "landscape", unit: "mm", format: "a4", compress: true });
  pdf.addFileToVFS("NotoSans-Regular.ttf", fonts.regular);
  pdf.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  pdf.addFileToVFS("NotoSans-Bold.ttf", fonts.bold);
  pdf.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  pdf.addFileToVFS("NotoSerif-Bold.ttf", fonts.serif);
  pdf.addFont("NotoSerif-Bold.ttf", "NotoSerif", "bold");
  pdf.setProperties({ title: doc.title, author: "OVERMAN", creator: "Портал OVERMAN" });

  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 14;
  const contentW = W - M * 2;
  const stamp = nowAlmaty();

  // ── шапка первой страницы: тёмная полоса с названием (как у «Сравнения недель»)
  pdf.setFillColor(...C.ink);
  pdf.rect(0, 0, W, 17, "F");
  pdf.setFont("NotoSans", "bold");
  pdf.setFontSize(13);
  pdf.setTextColor(255, 255, 255);
  pdf.text(clean(doc.title), M, 8);
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(8.2);
  pdf.setTextColor(210, 204, 190);
  const subtitleLines = doc.subtitle ? (pdf.splitTextToSize(clean(doc.subtitle), contentW * 0.62) as string[]) : [];
  if (subtitleLines.length > 0) pdf.text(subtitleLines[0], M, 13);
  pdf.setFont("NotoSans", "bold");
  pdf.setFontSize(8.5);
  pdf.setTextColor(255, 255, 255);
  pdf.text("OVERMAN · ПОРТАЛ БИЗНЕСА", W - M, 8, { align: "right" });
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(7);
  pdf.setTextColor(210, 204, 190);
  pdf.text(clean(`Сформировано ${stamp}${doc.author ? ` · ${doc.author}` : ""}`), W - M, 13, { align: "right" });

  let y = 23;
  if (subtitleLines.length > 1) {
    pdf.setFont("NotoSans", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(...C.muted);
    const rest = pdf.splitTextToSize(clean(subtitleLines.slice(1).join(" ")), contentW) as string[];
    pdf.text(rest, M, y);
    y += rest.length * 4.2;
  }
  if (doc.meta && doc.meta.length > 0) {
    pdf.setFont("NotoSans", "normal");
    pdf.setFontSize(8.2);
    pdf.setTextColor(...C.mutedLight);
    const lines = pdf.splitTextToSize(clean(doc.meta.join("   ·   ")), contentW) as string[];
    pdf.text(lines, M, y);
    y += lines.length * 4;
  }
  y += 3;

  // ── карточки показателей
  if (doc.kpis && doc.kpis.length > 0) {
    const perRow = Math.min(4, doc.kpis.length);
    const gap = 3.5;
    const cardW = (contentW - gap * (perRow - 1)) / perRow;
    const cardH = 19;
    doc.kpis.forEach((k, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = M + col * (cardW + gap);
      const cy = y + row * (cardH + gap);
      pdf.setFillColor(...C.paper);
      pdf.setDrawColor(...C.border);
      pdf.setLineWidth(0.25);
      pdf.roundedRect(x, cy, cardW, cardH, 2, 2, "FD");
      pdf.setFillColor(...C.accent);
      pdf.roundedRect(x, cy + 3.5, 0.9, cardH - 7, 0.4, 0.4, "F");
      pdf.setFont("NotoSans", "normal");
      pdf.setFontSize(7.4);
      pdf.setTextColor(...C.mutedLight);
      pdf.text(clean(k.label).toUpperCase(), x + 4.5, cy + 6.2, { charSpace: 0.25 });
      pdf.setFont("NotoSans", "bold");
      pdf.setFontSize(13.5);
      pdf.setTextColor(...C.ink);
      pdf.text(clean(k.value), x + 4.5, cy + 12.6);
      if (k.note) {
        pdf.setFont("NotoSans", "normal");
        pdf.setFontSize(7.2);
        pdf.setTextColor(...C.muted);
        pdf.text(clean(k.note), x + 4.5, cy + 16.4);
      }
    });
    y += Math.ceil(doc.kpis.length / perRow) * (cardH + gap) + 2;
  }

  // ── разделы-таблицы
  const contTop = 24;
  for (const section of doc.sections) {
    if (section.title || section.note) {
      // новый раздел не начинаем в самом низу страницы
      if (y > H - 45) {
        pdf.addPage();
        y = contTop;
      }
      if (section.title) {
        pdf.setFont("NotoSans", "bold");
        pdf.setFontSize(11.5);
        pdf.setTextColor(...C.ink);
        pdf.text(clean(section.title), M, y + 1);
        y += 5.5;
      }
      if (section.note) {
        pdf.setFont("NotoSans", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(...C.mutedLight);
        const lines = pdf.splitTextToSize(clean(section.note), contentW) as string[];
        pdf.text(lines, M, y);
        y += lines.length * 3.8 + 1;
      }
    }

    const align = section.headers.map((_, i) => section.align?.[i] ?? (i === 0 ? "left" : "right"));
    const weightSum = section.widths ? section.widths.reduce((a, v) => a + v, 0) : 0;
    const columnStyles: Record<number, { halign: "left" | "right" | "center"; cellWidth?: number }> = {};
    section.headers.forEach((_, i) => {
      columnStyles[i] = { halign: align[i] };
      if (section.widths && weightSum > 0) columnStyles[i].cellWidth = (contentW * section.widths[i]) / weightSum;
    });

    // шапка: обычная или двухэтажная (группы колонок)
    const hg = section.headGroups;
    let head: (string | { content: string; colSpan?: number; rowSpan?: number })[][] = [section.headers.map(clean)];
    if (hg && hg.length > 0) {
      head = [
        hg.map((g) => (g.subs ? { content: clean(g.label), colSpan: g.span } : { content: clean(g.label), rowSpan: 2 })),
        hg.flatMap((g) => (g.subs ? g.subs.map(clean) : [])),
      ];
    }
    // начала групп колонок (жирная линия слева) — только для таблицы с контурами
    const groupStarts = new Set<number>();
    if (section.grid) {
      let pos = 0;
      for (const g of hg ?? []) {
        groupStarts.add(pos);
        pos += g.span;
      }
    }
    const gridLine: [number, number, number] = [150, 143, 126];
    const bodyFont = section.fontSize ?? 8.4;
    const tightPad = section.fontSize !== undefined && section.fontSize < 8;
    autoTable(pdf, {
      startY: y,
      margin: { top: contTop, left: M, right: M, bottom: 16 },
      head,
      body: section.rows.map((r) => r.map(clean)),
      theme: "plain",
      tableWidth: contentW,
      styles: {
        font: "NotoSans",
        fontSize: bodyFont,
        textColor: C.ink,
        cellPadding: { top: 2.1, bottom: 2.1, left: tightPad ? 1.6 : 2.6, right: tightPad ? 1.6 : 2.6 },
        lineColor: section.grid ? gridLine : [255, 255, 255],
        lineWidth: section.grid ? 0.2 : 0.35,
        overflow: "linebreak",
        valign: "middle",
      },
      headStyles: {
        fillColor: C.ink,
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 7.6,
        cellPadding: { top: 2.8, bottom: 2.8, left: 2.6, right: 2.6 },
      },
      alternateRowStyles: { fillColor: C.stripe },
      columnStyles,
      didParseCell: (data) => {
        if (section.grid) {
          const heavy = groupStarts.has(data.column.index);
          data.cell.styles.lineWidth = { top: 0.2, bottom: 0.2, right: 0.2, left: heavy ? 0.7 : 0.2 };
          if (data.section === "head") data.cell.styles.lineColor = [255, 255, 255];
        }
        if (data.section === "head") {
          data.cell.styles.halign = hg && data.cell.colSpan > 1 ? "center" : align[data.column.index];
          if (hg && data.row.index === 1) {
            // второй этаж шапки — светлее, чтобы группы колонок читались
            data.cell.styles.fillColor = C.accentSoft;
            data.cell.styles.textColor = C.accent;
            data.cell.styles.fontSize = 7;
          }
          data.cell.styles.valign = "middle";
          return;
        }
        const kind = section.rowKinds?.[data.row.index] ?? "normal";
        if (kind === "group") {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.fillColor = C.paper;
        } else if (kind === "total") {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.fillColor = C.accentSoft;
          data.cell.styles.textColor = C.ink;
        } else if (kind === "sub") {
          data.cell.styles.textColor = C.muted;
          data.cell.styles.fontSize = 8;
        }
        if (section.signColors && (kind === "normal" || kind === "total")) {
          const first = String(data.cell.raw ?? "").trim();
          if (first.startsWith("+")) {
            data.cell.styles.textColor = C.green;
            data.cell.styles.fillColor = C.greenBg;
          } else if (first.startsWith("−") || first.startsWith("-")) {
            data.cell.styles.textColor = C.red;
            data.cell.styles.fillColor = C.redBg;
          }
        }
        if (section.softRed?.[data.row.index]?.[data.column.index]) {
          data.cell.styles.textColor = C.red;
          data.cell.styles.fillColor = C.redBg;
        }
        const indent = section.indent?.[data.row.index] ?? 0;
        if (data.column.index === 0 && indent > 0) {
          data.cell.styles.cellPadding = { top: 2.1, bottom: 2.1, left: 2.6 + indent * 4.2, right: 2.6 };
        }
      },
      didDrawPage: (data) => {
        if (data.pageNumber > 1) {
          pdf.setFillColor(...C.ink);
          pdf.rect(0, 0, W, 8, "F");
          pdf.setFont("NotoSans", "bold");
          pdf.setFontSize(8);
          pdf.setTextColor(255, 255, 255);
          pdf.text(clean(doc.title), M, 5.4);
          pdf.setFont("NotoSans", "normal");
          pdf.setFontSize(7.5);
          pdf.text("OVERMAN", W - M, 5.4, { align: "right" });
        }
      },
    });
    y = ((pdf as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 9;
  }

  // ── колонтитул на каждой странице
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    pdf.setDrawColor(...C.border);
    pdf.setLineWidth(0.25);
    pdf.line(M, H - 11, W - M, H - 11);
    pdf.setFont("NotoSans", "normal");
    pdf.setFontSize(7.6);
    pdf.setTextColor(...C.mutedLight);
    pdf.text("OVERMAN · Портал бизнеса", M, H - 6.5);
    pdf.text(`Страница ${i} из ${total}`, W - M, H - 6.5, { align: "right" });
  }
  return pdf;
}

// ── браузер: подгрузка шрифтов и скачивание файла
let fontsPromise: Promise<PdfFonts> | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function loadFonts(): Promise<PdfFonts> {
  if (!fontsPromise) {
    const get = async (name: string) => {
      const res = await fetch(`/fonts/pdf/${name}`);
      if (!res.ok) throw new Error("Не удалось загрузить шрифт для PDF");
      return toBase64(await res.arrayBuffer());
    };
    fontsPromise = Promise.all([get("NotoSans-Regular.ttf"), get("NotoSans-Bold.ttf"), get("NotoSerif-Bold.ttf")])
      .then(([regular, bold, serif]) => ({ regular, bold, serif }))
      .catch((e) => {
        fontsPromise = null;
        throw e;
      });
  }
  return fontsPromise;
}

export async function downloadPdf(doc: PdfDoc): Promise<void> {
  const fonts = await loadFonts();
  const pdf = buildPdf(doc, fonts);
  const safe = doc.fileName.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_");
  pdf.save(`${safe}.pdf`);
}
