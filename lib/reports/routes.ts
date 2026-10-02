// Какие отчёты в какие группы Telegram уходят. Ключи отчётов — из SCOPES
// (lib/reports/sales.ts): point_1 — Актау, point_3 — Актобе, all — общий.
export const REPORT_ROUTES: { label: string; chatId: string; scopes: string[] }[] = [
  { label: "Отчеты по продажам АКТАУ", chatId: "-1004419034959", scopes: ["point_1"] },
  { label: "Отчет (все)", chatId: "-1003938364806", scopes: ["point_1", "point_3", "all"] },
];
