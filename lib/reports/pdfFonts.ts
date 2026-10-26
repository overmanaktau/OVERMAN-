// Шрифты для PDF на сервере: файлы из public/fonts/pdf (в них есть кириллица, казахские буквы и знак тенге); если файлов рядом нет — с сайта.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PdfFonts } from "@/lib/exportPdf";

export async function loadPdfFonts(): Promise<PdfFonts> {
  const get = async (name: string) => {
    try {
      return (await readFile(path.join(process.cwd(), "public", "fonts", "pdf", name))).toString("base64");
    } catch {
      const res = await fetch(`https://www.overman.kz/fonts/pdf/${name}`);
      if (!res.ok) throw new Error(`Шрифт ${name} недоступен.`);
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    }
  };
  const [regular, bold, serif] = await Promise.all([get("NotoSans-Regular.ttf"), get("NotoSans-Bold.ttf"), get("NotoSerif-Bold.ttf")]);
  return { regular, bold, serif };
}
