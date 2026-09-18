import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const roleId = Number(params.id);
  const body = await request.json();
  const { name, permissions } = body as {
    name?: string;
    permissions?: Record<string, { canView?: boolean; canEdit?: boolean }>;
  };

  if (name?.trim()) {
    const { error } = await supabaseAdmin.from("roles").update({ name: name.trim() }).eq("id", roleId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (permissions) {
    const rows = Object.entries(permissions).map(([section, p]) => ({
      role_id: roleId,
      section,
      can_view: !!p.canView,
      can_edit: !!p.canEdit,
    }));
    const { error } = await supabaseAdmin
      .from("role_permissions")
      .upsert(rows, { onConflict: "role_id,section" });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const roleId = Number(params.id);
  const { count, error: countError } = await supabaseAdmin
    .from("user_roles")
    .select("user_id", { count: "exact", head: true })
    .eq("role_id", roleId);
  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });
  if (count && count > 0) {
    return NextResponse.json(
      { error: "Роль назначена сотрудникам — сначала переназначьте им другую роль." },
      { status: 400 }
    );
  }

  await supabaseAdmin.from("role_permissions").delete().eq("role_id", roleId);
  const { error } = await supabaseAdmin.from("roles").delete().eq("id", roleId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
