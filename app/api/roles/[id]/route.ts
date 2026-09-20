import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSettingsAccess } from "@/lib/requireAdmin";

// See app/api/roles/route.ts — a delegated (non-admin) settings manager can't
// touch these two sections on any role, to prevent granting admin-equivalent
// power to themselves or anyone else.
const ADMIN_ONLY_SECTIONS = ["settings.employees", "profile.rename"];

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

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
    let effective = permissions;
    if (!caller.isAdmin) {
      // Keep whatever these two sections were already set to — a delegated
      // manager's save must not be able to change them either way.
      const { data: existing } = await supabaseAdmin
        .from("role_permissions")
        .select("section, can_view, can_edit")
        .eq("role_id", roleId)
        .in("section", ADMIN_ONLY_SECTIONS);
      const existingBySection = new Map((existing ?? []).map((r) => [r.section, r]));
      effective = { ...permissions };
      for (const section of ADMIN_ONLY_SECTIONS) {
        const prev = existingBySection.get(section);
        effective[section] = { canView: prev?.can_view ?? false, canEdit: prev?.can_edit ?? false };
      }
    }

    const rows = Object.entries(effective).map(([section, p]) => ({
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
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

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
