import { supabaseAdmin } from "./supabaseAdmin";

// Verifies the request's bearer token belongs to a logged-in admin.
// Returns the auth user on success, null otherwise (route handlers should 403).
export async function requireAdmin(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const { data: userData, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !userData.user) return null;

  const { data: roleRow } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (roleRow?.role !== "admin") return null;
  return userData.user;
}
