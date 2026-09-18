import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const body = await request.json();
  const { role, roleId } = body as { role?: "admin" | "custom"; roleId?: number | null };

  const { error } = await supabaseAdmin.from("user_roles").upsert({
    user_id: params.id,
    role: role === "admin" ? "admin" : "editor",
    role_id: role === "admin" ? null : roleId ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  if (params.id === admin.id) {
    return NextResponse.json({ error: "Нельзя удалить самого себя." }, { status: 400 });
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await supabaseAdmin.from("user_roles").delete().eq("user_id", params.id);

  return NextResponse.json({ ok: true });
}
