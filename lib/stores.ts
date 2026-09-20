export type City = { id: number; name: string };
export type Store = { id: number; city_id: number; name: string; code: string };
export type StoreAccessGrant = { scope: "all" | "city" | "store"; city_id: number | null; store_id: number | null };

export function resolveAccessibleStoreCodes(stores: Store[], grants: StoreAccessGrant[]): string[] {
  if (grants.some((g) => g.scope === "all")) return stores.map((s) => s.code);
  const cityIds = new Set(grants.filter((g) => g.scope === "city").map((g) => g.city_id));
  const storeIds = new Set(grants.filter((g) => g.scope === "store").map((g) => g.store_id));
  return stores.filter((s) => cityIds.has(s.city_id) || storeIds.has(s.id)).map((s) => s.code);
}
