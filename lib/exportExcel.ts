// Excel (RU locale, which is what this business runs on) expects ";" as the
// list separator for a double-clicked CSV — a comma-separated file opens
// with everything crammed into a single column instead of proper cells.
// The UTF-8 BOM is what makes Excel read Cyrillic correctly instead of
// mangling it.
export function downloadExcel(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    // RU Excel expects "," as the decimal separator. A JS number with a "."
    // (e.g. 17.4) is ambiguous with a day.month date, and Excel's RU locale
    // silently reinterprets it as one (17.4 becomes "17 апреля") instead of
    // showing the actual number — swapping the separator avoids that entirely.
    const s = typeof v === "number" ? String(v).replace(".", ",") : v;
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
