import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function GET(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const { data: authUsers, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
  if (usersError) return NextResponse.json({ error: usersError.message }, { status: 500 });

  const { data: roleRows, error: rolesError } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role, role_id, full_name");
  if (rolesError) return NextResponse.json({ error: rolesError.message }, { status: 500 });

  const roleByUser = new Map((roleRows ?? []).map((r) => [r.user_id, r]));
  const employees = authUsers.users.map((u) => {
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

  return NextResponse.json({ employees });
}

export async function POST(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const body = await request.json();
  const { email, password, role, roleId, fullName } = body as {
    email?: string;
    password?: string;
    role?: "admin" | "custom";
    roleId?: number | null;
    fullName?: string | null;
  };

  if (!email || !password) {
    return NextResponse.json({ error: "Email и пароль обязательны." }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Пароль должен быть не короче 6 символов." }, { status: 400 });
  }

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) return NextResponse.json({ error: createError.message }, { status: 400 });

  const { error: roleError } = await supabaseAdmin.from("user_roles").insert({
    user_id: created.user.id,
    role: role === "admin" ? "admin" : "editor",
    role_id: role === "admin" ? null : roleId ?? null,
    full_name: fullName?.trim() || null,
  });
  if (roleError) {
    // Roll back the auth user so we don't leave an account with no role row.
    await supabaseAdmin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: roleError.message }, { status: 400 });
  }

  return NextResponse.json({ id: created.user.id, email: created.user.email, fullName: fullName?.trim() || null });
}
