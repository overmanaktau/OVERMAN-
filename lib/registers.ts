// Кассы МойСклад (entity/retailstore, «точки продаж» — не «склад», у склада города в названии нет),
// которые считаются в продажах, и город каждой. Общая карта для ночной синхронизации и для
// сверки отчётов (раньше жила в app/api/moysklad/sync/route.ts).
//
// Всё считается по факту: если касса пробила продажи за день, они попадают в этот день — даже
// если касса сегодня в архиве МойСклад (её не удаляют, история остаётся). Это касается и
// «Актобе (скидка)» (id 111827a0…) за любые даты. «Онлайн продажи Overman» и «Ак Кала» —
// неактивные записи, их пропускаем.
//
// Единственное исключение — Saya Park (теперь «Актау (скидка)»): по решению владельца он не
// считается с SAYA_PARK_RETIRED_FROM (21 сентября включительно); всё, что раньше, — реальные
// продажи и должно пересчитываться правильно, поэтому пропуск привязан к дате, а не к
// удалению из карты. Склад Saya Park (WAREHOUSE_STORE) от даты не зависит: товар физически
// может там лежать, даже когда касса не пробивает продажи.
//
// Город, а не склад: карта кормит moysklad_registers/moysklad_sales_daily, которые «Продажа» и
// «Обзор» фильтруют по выбору города в боковой панели (point_1/point_3).
export const REGISTER_STORE: Record<string, string> = {
  "01e67f9f-b012-11f0-0a80-0d700024a20d": "point_1", // Overman Актау
  "d3f209de-4da2-11f0-0a80-027a0003cde2": "point_1", // Saya Park
  "26e2dddd-a37f-11f1-0a80-1a76002585af": "point_3", // Overman Актобе
  "111827a0-a440-11f1-0a80-0dcb003111ce": "point_3", // Актобе скидка
};
export const SAYA_PARK_REGISTER_ID = "d3f209de-4da2-11f0-0a80-027a0003cde2";
export const SAYA_PARK_WAREHOUSE_ID = "fe3b03d3-4da1-11f0-0a80-18910004c37d";
export const SAYA_PARK_RETIRED_FROM = "2026-09-21"; // сравнивается как строка: даты всегда «YYYY-MM-DD»

// Считается ли касса в продажах за эту дату.
export function registerCounts(registerId: string, date: string): boolean {
  if (!REGISTER_STORE[registerId]) return false;
  if (registerId === SAYA_PARK_REGISTER_ID && date >= SAYA_PARK_RETIRED_FROM) return false;
  return true;
}
