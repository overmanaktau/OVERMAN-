import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSettingsAccess } from "@/lib/requireAdmin";
import { listEmployees } from "@/lib/employees";
import { getErrorMessage } from "@/lib/errors";

export async function GET(request: Request) {
  const caller = await requireSettingsAccess(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  try {
    const employees = await listEmployees();
    return NextResponse.json({ employees });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

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
  if (role === "admin" && !caller.isAdmin) {
    return NextResponse.json({ error: "Назначать роль администратора может только администратор." }, { status: 403 });
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
