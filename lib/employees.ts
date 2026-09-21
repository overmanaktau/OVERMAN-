import { supabaseAdmin } from "./supabaseAdmin";

export type EmployeeSummary = {
  id: string;
  email: string;
  fullName: string | null;
  role: "owner" | "admin" | "editor" | null;
  roleId: number | null;
  createdAt: string;
};

export async function listEmployees(): Promise<EmployeeSummary[]> {
  const { data: authUsers, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
  if (usersError) throw usersError;

  const { data: roleRows, error: rolesError } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role, role_id, full_name");
  if (rolesError) throw rolesError;

  const roleByUser = new Map((roleRows ?? []).map((r) => [r.user_id, r]));
  return authUsers.users.map((u) => {
    const r = roleByUser.get(u.id);
    return {
      id: u.id,
      email: u.email ?? "",
      fullName: r?.full_name ?? null,
      role: r?.role ?? null,
      roleId: r?.role_id ?? null,
      createdAt: u.created_at,
    };
  });
}

// Deletes the auth user, their role row, and — if that role was a personal
// (per-employee) one now orphaned — the role itself. Shared roles are left
// alone even if this was the last employee using them.
export async function deleteEmployeeAccount(userId: string): Promise<{ error?: string }> {
  const { data: roleRow } = await supabaseAdmin
    .from("user_roles")
    .select("role_id")
    .eq("user_id", userId)
    .maybeSingle();

  // user_roles.user_id has no ON DELETE CASCADE onto auth.users, so the role
  // row must go first — deleting the auth user while it's still referenced
  // fails with a foreign key violation.
  const { error: roleDeleteError } = await supabaseAdmin.from("user_roles").delete().eq("user_id", userId);
  if (roleDeleteError) return { error: roleDeleteError.message };

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) return { error: error.message };

  if (roleRow?.role_id) {
    const { data: role } = await supabaseAdmin
      .from("roles")
      .select("is_personal")
      .eq("id", roleRow.role_id)
      .maybeSingle();
    if (role?.is_personal) {
      await supabaseAdmin.from("roles").delete().eq("id", roleRow.role_id);
    }
  }

  return {};
}
