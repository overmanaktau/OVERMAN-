import * as XLSX from "xlsx";

// A real .xlsx (not a CSV renamed to look like one) so Excel gets typed
// cells — no more guessing a decimal number for a day.month date — and an
// actual column-width column so a date like "01.09.2026" doesn't get
// clipped to "####" on first open.
//
// Only ever used to WRITE workbooks built from our own trusted data here —
// never to parse an uploaded/external file — which is the only path the
// known SheetJS advisories (prototype pollution, ReDoS) apply to.
export function downloadExcel(filename: string, headers: string[], rows: (string | number)[][]) {
  const data: (string | number)[][] = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(data);

  ws["!cols"] = headers.map((header, col) => {
    let max = String(header).length;
    for (const row of rows) {
      const len = String(row[col] ?? "").length;
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 8), 40) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Данные");
  XLSX.writeFile(wb, filename.replace(/\.csv$/i, "") + ".xlsx");
}
