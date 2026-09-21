import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSettingsAccess } from "@/lib/requireAdmin";
import { deleteEmployeeAccount } from "@/lib/employees";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  // No one touches the owner's own row but the owner — not even another admin.
  const { data: targetBefore } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", params.id)
    .maybeSingle();
  if (targetBefore?.role === "owner" && params.id !== caller.user.id) {
    return NextResponse.json({ error: "Изменять данные владельца может только он сам." }, { status: 403 });
  }

  const body = await request.json();
  const { role, roleId, fullName, email, password } = body as {
    role?: "admin" | "owner" | "custom";
    roleId?: number | null;
    fullName?: string | null;
    email?: string;
    password?: string;
  };

  if (role === "admin" && !caller.isAdmin) {
    return NextResponse.json({ error: "Назначать роль администратора может только администратор." }, { status: 403 });
  }

  // Transferring ownership: only the current owner can hand it off, and doing
  // so demotes them to admin — there can only ever be one owner at a time.
  if (role === "owner") {
    if (caller.role !== "owner") {
      return NextResponse.json({ error: "Передать роль владельца может только текущий владелец." }, { status: 403 });
    }
    if (params.id === caller.user.id) {
      return NextResponse.json({ error: "Нельзя передать роль владельца самому себе." }, { status: 400 });
    }

    const { error: demoteError } = await supabaseAdmin
      .from("user_roles")
      .update({ role: "admin", role_id: null })
      .eq("user_id", caller.user.id);
    if (demoteError) return NextResponse.json({ error: demoteError.message }, { status: 400 });

    const { error: promoteError } = await supabaseAdmin
      .from("user_roles")
      .update({ role: "owner", role_id: null })
      .eq("user_id", params.id);
    if (promoteError) {
      await supabaseAdmin.from("user_roles").update({ role: "owner" }).eq("user_id", caller.user.id);
      return NextResponse.json({ error: promoteError.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  }

  if (email !== undefined || password !== undefined) {
    if (password !== undefined && password.length < 6) {
      return NextResponse.json({ error: "Пароль должен быть не короче 6 символов." }, { status: 400 });
    }
    const attrs: Record<string, unknown> = {};
    if (email !== undefined) {
      attrs.email = email.trim();
      attrs.email_confirm = true; // admin-set email is usable immediately, no confirmation link needed
    }
    if (password !== undefined) attrs.password = password;
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(params.id, attrs);
    if (authError) return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  const payload: Record<string, unknown> = { user_id: params.id };
  if (role !== undefined) {
    payload.role = role === "admin" ? "admin" : "editor";
    payload.role_id = role === "admin" ? null : roleId ?? null;
  }
  if (fullName !== undefined) {
    payload.full_name = fullName?.trim() || null;
  }

  if (Object.keys(payload).length > 1) {
    const { error } = await supabaseAdmin.from("user_roles").upsert(payload);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  if (params.id === caller.user.id) {
    return NextResponse.json({ error: "Нельзя удалить самого себя." }, { status: 400 });
  }

  const { data: targetRow } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", params.id)
    .maybeSingle();
  if (targetRow?.role === "owner") {
    return NextResponse.json({ error: "Владельца нельзя удалить." }, { status: 403 });
  }

  const result = await deleteEmployeeAccount(params.id);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true });
}
