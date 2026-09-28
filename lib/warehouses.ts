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

// A role granted access to a city (via the sidebar's city picker) can see
// every real warehouse inside it — this expands the coarse city codes
// (point_1/point_3) accessibleStoreCodes carries into the granular ones the
// product tables actually use.
export function warehousesForCities(cityCodes: string[]): string[] {
  return WAREHOUSES.filter((w) => cityCodes.includes(w.cityCode)).map((w) => w.code);
}
