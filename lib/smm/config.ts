// Настройки бота для СММ: города, их аккаунты Instagram и рекламные кабинеты Meta, роли и кто что видит.
export type CityKey = "aktau" | "aktobe";
export const CITY_KEYS: CityKey[] = ["aktau", "aktobe"];

export const CITIES: Record<CityKey, { title: string; ig: string; ad: string; store: string }> = {
  aktau: { title: "Актау", ig: "17841475959353007", ad: "act_1102340531050076", store: "overman_aktau" },
  aktobe: { title: "Актобе", ig: "17841446559692743", ad: "act_182042481376645", store: "overman_aktobe" },
};

// Онлайн-продавец (чеки с её именем — онлайн-продажи), только Актау.
export const ONLINE_SELLER = { ms_id: "4d408fda-490d-11f1-0a80-1a3e0018b649", name: "Болат Наргиза", city: "aktau" as CityKey };

export type SmmRole = "smm_aktau" | "smm_aktobe" | "marketer" | "admin";
export const SMM_ROLES: SmmRole[] = ["smm_aktau", "smm_aktobe", "marketer", "admin"];
export const ROLE_TITLE: Record<SmmRole, string> = {
  smm_aktau: "СММ АКТАУ",
  smm_aktobe: "СММ АКТОБЕ",
  marketer: "МАРКЕТОЛОГ",
  admin: "АДМИНИСТРАТОР",
};

export function citiesOf(role: SmmRole): CityKey[] {
  if (role === "smm_aktau") return ["aktau"];
  if (role === "smm_aktobe") return ["aktobe"];
  return ["aktau", "aktobe"];
}
// Расход на рекламу и управление людьми — только маркетолог и администратор.
export const seesSpend = (role: SmmRole) => role === "marketer" || role === "admin";