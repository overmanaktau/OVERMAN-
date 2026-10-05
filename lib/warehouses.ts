// Real склады/кассы, one row per store code that moysklad_product_stock and
// moysklad_product_sales_daily use — must mirror WAREHOUSE_STORE in
// app/api/moysklad/sync/route.ts by hand (that one maps МойСклад's own
// warehouse ids to these same codes; this one adds the display name and
// which city a role needs access to in order to see it).
export const WAREHOUSES: { code: string; label: string; cityCode: string }[] = [
  { code: "overman_aktau", label: "Overman Актау", cityCode: "point_1" },
  { code: "saya_park", label: "Saya Park", cityCode: "point_1" },
  { code: "overman_aktobe", label: "Overman Актобе", cityCode: "point_3" },
  { code: "aktobe_discount", label: "Актобе скидка", cityCode: "point_3" },
];

// МойСклад-id склада (entity/store) → код склада выше. Сюда попадает только то, что мы
// отслеживаем; всё остальное (например пустой «Кайнар») синхронизация пропускает.
// Две «заморозки» — отдельная корзина (остатки, придержанные до следующего сезона), они
// не входят ни в один город. Раньше эта карта жила в app/api/moysklad/sync/route.ts.
export const WAREHOUSE_STORE: Record<string, string> = {
  "109ed308-b012-11f0-0a80-110900247319": "overman_aktau", // Overman
  "fe3b03d3-4da1-11f0-0a80-18910004c37d": "saya_park", // Saya Park
  "bb935bd2-93e9-11f1-0a80-1f560022775d": "overman_aktobe", // Aktobe OVERMAN
  "2ca9443b-a440-11f1-0a80-03ac00324d3c": "aktobe_discount", // Актобе скидка
  "14352a86-5e96-11f1-0a80-1cbd00149396": "frozen", // заморозка 03.06.2026
  "554d7479-2728-11f0-0a80-15980025a3f6": "frozen", // Заморозка 24.02.2026
};

// A role granted access to a city (via the sidebar's city picker) can see
// every real warehouse inside it — this expands the coarse city codes
// (point_1/point_3) accessibleStoreCodes carries into the granular ones the
// product tables actually use.
export function warehousesForCities(cityCodes: string[]): string[] {
  return WAREHOUSES.filter((w) => cityCodes.includes(w.cityCode)).map((w) => w.code);
}
