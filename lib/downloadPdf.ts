import type { PdfDoc } from "@/lib/exportPdf";

export type { PdfDoc, PdfSection, PdfRowKind } from "@/lib/exportPdf";

// Библиотека PDF тяжёлая — подгружаем её только в момент нажатия кнопки,
// чтобы она не раздувала загрузку страниц.
export async function downloadPdf(doc: PdfDoc): Promise<void> {
  const mod = await import("@/lib/exportPdf");
  await mod.downloadPdf(doc);
}
