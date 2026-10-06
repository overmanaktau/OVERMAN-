"use client";

import { useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { downloadPdf, type PdfDoc } from "@/lib/downloadPdf";

// Кнопка «Скачать PDF»: страница отдаёт описание документа (заголовок, показатели,
// таблицы), оформление и сам файл делает lib/exportPdf.
export default function PdfButton({
  build,
  className,
  label = "Скачать PDF",
  disabled,
}: {
  build: () => PdfDoc | Promise<PdfDoc>;
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const { fullName, email } = useAuth();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const doc = await build();
      await downloadPdf({ ...doc, author: doc.author ?? fullName ?? email });
    } catch (e) {
      window.alert(`Не удалось сформировать PDF: ${e instanceof Error ? e.message : "ошибка"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={className ?? "text-[13px] font-semibold text-accent bg-surface border border-border rounded-md px-3.5 py-2 hover:bg-paper disabled:opacity-50"}
    >
      {busy ? "Готовим PDF…" : label}
    </button>
  );
}
