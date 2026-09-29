// Excel (RU locale, which is what this business runs on) expects ";" as the
// list separator for a double-clicked CSV — a comma-separated file opens
// with everything crammed into a single column instead of proper cells.
// The UTF-8 BOM is what makes Excel read Cyrillic correctly instead of
// mangling it.
export function downloadExcel(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
