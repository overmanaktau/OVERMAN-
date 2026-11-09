// Доступ к экрану кассы: раздел «kassa» (просмотр — клиенты и поиск сертификатов, правка — продажа, использование и
// возврат сертификатов) и город входа: у кассира один город (из доступов роли), у админа и владельца — любой.
import { requireSectionStores, type SectionCaller } from "@/lib/sectionAccess";

export type KassaCaller = SectionCaller;

export function requireKassa(request: Request, need: "view" | "edit"): Promise<KassaCaller | null> {
  return requireSectionStores(request, "kassa", need);
}
