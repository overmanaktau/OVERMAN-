import { supabaseAdmin } from "./supabaseAdmin";

async function getCallerRole(token: string) {
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !userData.user) return null;

  const { data: roleRow } = await supabaseAdmin
    .from("user_roles")
    .select("role, role_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  return { user: userData.user, role: roleRow?.role ?? null, roleId: roleRow?.role_id ?? null };
}

// Strictly admin-or-owner — for actions that must never be delegated to a
// custom role. The owner counts as admin here too: it's a superset, not a
// separate track.
export async function requireAdmin(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const caller = await getCallerRole(token);
  if (!caller || (caller.role !== "admin" && caller.role !== "owner")) return null;
  return caller.user;
}

// Admins/owner, or anyone whose role was explicitly granted the given
// section's permission (view lets them browse; edit lets them create/change/
// delete). `isAdmin` on the result tells the caller whether this was a real
// admin/owner or a delegated permission — routes use it to block privilege
// escalation (e.g. a delegated manager promoting someone, including
// themselves, to admin). `role` exposes the exact role for routes that need
// to tell an owner apart from a plain admin (e.g. transferring ownership).
export async function requireSectionAccess(
  request: Request,
  section: string,
  need: "view" | "edit"
): Promise<{
  user: NonNullable<Awaited<ReturnType<typeof getCallerRole>>>["user"];
  isAdmin: boolean;
  role: "owner" | "admin" | "editor" | null;
} | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const caller = await getCallerRole(token);
  if (!caller) return null;
  if (caller.role === "admin" || caller.role === "owner") {
    return { user: caller.user, isAdmin: true, role: caller.role };
  }
  if (!caller.roleId) return null;

  const { data: permRow } = await supabaseAdmin
    .from("role_permissions")
    .select("can_view, can_edit")
    .eq("role_id", caller.roleId)
    .eq("section", section)
    .maybeSingle();

  const allowed = need === "view" ? !!permRow?.can_view : !!permRow?.can_edit;
  return allowed ? { user: caller.user, isAdmin: false, role: caller.role as "editor" | null } : null;
}

export function requireSettingsAccess(request: Request, need: "view" | "edit") {
  return requireSectionAccess(request, "settings.employees", need);
}

export function requireRequestsAccess(request: Request, need: "view" | "edit") {
  return requireSectionAccess(request, "requests", need);
}
