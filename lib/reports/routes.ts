// Какие отчёты в какие группы Telegram уходят. Ключи отчётов — из SCOPES
// (lib/reports/sales.ts): point_1 — Актау, point_3 — Актобе, all — общий.
export const REPORT_ROUTES: { label: string; chatId: string; scopes: string[] }[] = [
  { label: "Отчеты по продажам АКТАУ", chatId: "-5485168003", scopes: ["point_1"] },
  { label: "Отчет (все)", chatId: "-5587442749", scopes: ["point_1", "point_3", "all"] },
];
