import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

// Единая выгрузка в PDF для всех разделов портала. Оформление в цветах портала:
// тёплая бумага, глубокий зелёный акцент, мягкая зебра в таблицах, крупные итоги,
// колонтитул с номером страницы. Шрифты (Noto Sans и Noto Serif) лежат в
// public/fonts/pdf — в них есть кириллица, казахские буквы и знак тенге.

export type PdfRowKind = "normal" | "group" | "sub" | "total";

export type PdfSection = {
  title?: string;
  note?: string;
  headers: string[];
  rows: (string | number)[][];
  align?: ("left" | "right" | "center")[]; // по колонкам; по умолчанию первая слева, остальные справа
  widths?: number[]; // относительные ширины колонок (необязательно)
  rowKinds?: PdfRowKind[]; // оформление строк: подгруппа, итог
  indent?: number[]; // отступ первой колонки (уровень вложенности) по строкам
  // — для окна «Что скачать» (PdfButton): —
  optional?: boolean; // по умолчанию не отмечена (например, краткая сводка рядом с подробной)
  hint?: string; // пояснение под названием в окне выбора
  levelLabels?: string[]; // названия уровней детализации: «Только поставщики», «+ артикулы», …
  units?: string[]; // для load: названия основных строк (чтобы в окне можно было выбрать нужные)
  load?: (opts: { skip: Set<number> }) => Promise<PdfSection>; // подгрузить строки, только если блок выбран; skip — номера снятых основных строк
};

export type PdfDoc = {
  fileName: string; // без .pdf
  title: string;
  subtitle?: string; // период, фильтры
  meta?: string[]; // мелкие подписи под заголовком
  kpis?: { label: string; value: string; note?: string }[];
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
};

// В шрифтах нет стрелок и геометрических фигур — заменяем на то, что точно есть.
function clean(v: string | number): string {
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("ru-RU").replace(/\u00a0|\u202f/g, " ") : "";
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

  // ── шапка первой страницы
  pdf.setFont("NotoSerif", "bold");
  pdf.setFontSize(15);
  pdf.setTextColor(...C.ink);
  pdf.text("OVERMAN", M, 15);
  pdf.setFont("NotoSans", "normal");
  pdf.setFontSize(6.8);
  pdf.setTextColor(...C.mutedLight);
  pdf.text("ПОРТАЛ БИЗНЕСА", M + 31, 14.8, { charSpace: 0.6 });
  pdf.setFontSize(8);
  pdf.text(clean(`Сформировано ${stamp}${doc.author ? ` · ${doc.author}` : ""}`), W - M, 14.8, { align: "right" });
  pdf.setDrawColor(...C.accent);
  pdf.setLineWidth(0.7);
  pdf.line(M, 19, W - M, 19);
  pdf.setDrawColor(...C.tan);
  pdf.setLineWidth(0.25);
  pdf.line(M, 20, M + 24, 20);

  // ── заголовок
  let y = 31;
  pdf.setFont("NotoSerif", "bold");
  pdf.setFontSize(21);
  pdf.setTextColor(...C.ink);
  pdf.text(clean(doc.title), M, y);
  y += 6.5;
  if (doc.subtitle) {
    pdf.setFont("NotoSans", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(...C.muted);
    const lines = pdf.splitTextToSize(clean(doc.subtitle), contentW) as string[];
    pdf.text(lines, M, y);
    y += lines.length * 4.6;
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
        pdf.setFont("NotoSerif", "bold");
        pdf.setFontSize(12.5);
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

    autoTable(pdf, {
      startY: y,
      margin: { top: contTop, left: M, right: M, bottom: 16 },
      head: [section.headers.map(clean)],
      body: section.rows.map((r) => r.map(clean)),
      theme: "plain",
      tableWidth: contentW,
      styles: {
        font: "NotoSans",
        fontSize: 8.4,
        textColor: C.ink,
        cellPadding: { top: 2.1, bottom: 2.1, left: 2.6, right: 2.6 },
        lineColor: C.soft,
        lineWidth: 0,
        overflow: "linebreak",
        valign: "middle",
      },
      headStyles: {
        fillColor: C.accent,
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 7.6,
        cellPadding: { top: 2.8, bottom: 2.8, left: 2.6, right: 2.6 },
      },
      alternateRowStyles: { fillColor: C.stripe },
      columnStyles,
      didParseCell: (data) => {
        if (data.section === "head") {
          data.cell.styles.halign = align[data.column.index];
          return;
        }
        const kind = section.rowKinds?.[data.row.index] ?? "normal";
        if (kind === "group") {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.fillColor = C.soft;
        } else if (kind === "total") {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.fillColor = C.accentSoft;
          data.cell.styles.textColor = C.accent;
        } else if (kind === "sub") {
          data.cell.styles.textColor = C.muted;
          data.cell.styles.fontSize = 8;
        }
        const indent = section.indent?.[data.row.index] ?? 0;
        if (data.column.index === 0 && indent > 0) {
          data.cell.styles.cellPadding = { top: 2.1, bottom: 2.1, left: 2.6 + indent * 4.2, right: 2.6 };
        }
      },
      didDrawCell: (data) => {
        if (data.section !== "body") return;
        // тонкая линия под каждой строкой — глазу проще держать строку
        pdf.setDrawColor(...C.soft);
        pdf.setLineWidth(0.15);
        pdf.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
      },
      didDrawPage: (data) => {
        if (data.pageNumber > 1) {
          pdf.setFont("NotoSerif", "bold");
          pdf.setFontSize(9);
          pdf.setTextColor(...C.ink);
          pdf.text("OVERMAN", M, 12);
          pdf.setFont("NotoSans", "normal");
          pdf.setFontSize(8);
          pdf.setTextColor(...C.mutedLight);
          pdf.text(clean(doc.title), W - M, 12, { align: "right" });
          pdf.setDrawColor(...C.accent);
          pdf.setLineWidth(0.4);
          pdf.line(M, 15, W - M, 15);
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
