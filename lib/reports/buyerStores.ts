// Склады, которые участвуют в отчётах закупщика: только два основных (Overman Актау и Overman Актобе). Заморозка, Saya Park и «Актобе скидка» —
// нигде (решение владельца 26.10.2026). «all» — оба города вместе.
export const BUYER_STORES: Record<string, string[]> = {
  point_1: ["overman_aktau"],
  point_3: ["overman_aktobe"],
  all: ["overman_aktau", "overman_aktobe"],
};
export const BUYER_CITY_TITLE: Record<string, string> = { point_1: "Актау", point_3: "Актобе", all: "Все города" };
