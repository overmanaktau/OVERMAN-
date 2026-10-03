// Какие отчёты в какие группы Telegram уходят. Ключи отчётов — из SCOPES
// (lib/reports/sales.ts): point_1 — Актау, point_3 — Актобе, all — общий.
// scopes — ежедневные отчёты, periodScopes — недельный (по понедельникам) и
// месячный (1-го числа) отчёты.
// Всё раздельно по городам (решение владельца): у каждого города две группы.
// «Отчеты по продажам …» — отчёты по продажам города (день, неделя, месяц);
// «Overman …» — группа, куда идут ВСЕ отчёты этого города (сейчас те же день,
// неделя и месяц, любой новый отчёт по городу добавлять и сюда). Актау — только
// в группы Актау, Актобе — только в группы Актобе. Общий отчёт («all») пока
// никуда не отправляется.
export const REPORT_ROUTES: { label: string; chatId: string; scopes: string[]; periodScopes?: string[] }[] = [
  { label: "Отчеты по продажам АКТАУ", chatId: "-1004419034959", scopes: ["point_1"], periodScopes: ["point_1"] },
  { label: "Overman АКТАУ", chatId: "-1003938364806", scopes: ["point_1"], periodScopes: ["point_1"] },
  { label: "Отчеты по продажам АКТОБЕ", chatId: "-1003922287033", scopes: ["point_3"], periodScopes: ["point_3"] },
  { label: "Overman АКТОБЕ", chatId: "-1003924067979", scopes: ["point_3"], periodScopes: ["point_3"] },
];
