// Доступ к экрану кассы: раздел «kassa» (просмотр — клиенты и поиск сертификатов, правка — продажа, использование и
// возврат сертификатов) и город входа: у кассира один город (из доступов роли), у админа и владельца — любой.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type KassaCaller = { userId: string; name: string; stores: string[]; canEdit: boolean };

export async function requireKassa(request: Request, need: "view" | "edit"): Promise<KassaCaller | null> {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !userData.user) return null;
  const { data: roleRow } = await supabaseAdmin.from("user_roles").select("role, role_id, full_name").eq("user_id", userData.user.id).maybeSingle();
  if (!roleRow) return null;
  const name = (roleRow.full_name as string | null) ?? userData.user.email ?? "Касса";

  const { data: allStores } = await supabaseAdmin.from("stores").select("id, city_id, code");
  const stores = (allStores ?? []) as { id: number; city_id: number; code: string }[];

  if (roleRow.role === "admin" || roleRow.role === "owner") {
    return { userId: userData.user.id, name, stores: stores.map((s) => s.code), canEdit: true };
  }
  if (!roleRow.role_id) return null;
  const { data: perm } = await supabaseAdmin.from("role_permissions").select("can_view, can_edit").eq("role_id", roleRow.role_id).eq("section", "kassa").maybeSingle();
  if (!perm?.can_view || (need === "edit" && !perm.can_edit)) return null;

  const { data: grants } = await supabaseAdmin.from("role_store_access").select("scope, city_id, store_id").eq("role_id", roleRow.role_id);
  const g = (grants ?? []) as { scope: string; city_id: number | null; store_id: number | null }[];
  const codes = g.some((x) => x.scope === "all")
    ? stores.map((s) => s.code)
    : stores.filter((s) => g.some((x) => (x.scope === "city" && x.city_id === s.city_id) || (x.scope === "store" && x.store_id === s.id))).map((s) => s.code);
  if (codes.length === 0) return null;
  return { userId: userData.user.id, name, stores: codes, canEdit: !!perm.can_edit };
}
