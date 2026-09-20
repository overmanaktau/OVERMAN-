import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSettingsAccess } from "@/lib/requireAdmin";

// A delegated (non-admin) settings manager can grant any section except these
// two — otherwise they could hand any role, including their own, admin-equivalent
// power over employees or the ability to rename anyone.
const ADMIN_ONLY_SECTIONS = ["settings.employees", "profile.rename"];

export async function GET(request: Request) {
  const caller = await requireSettingsAccess(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from("roles")
    .select(
      "id, name, is_personal, role_permissions(section, can_view, can_edit), role_store_access(scope, city_id, store_id)"
    )
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ roles: data });
}

export async function POST(request: Request) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  const body = await request.json();
  const { name, permissions, isPersonal } = body as {
    name?: string;
    permissions?: Record<string, { canView?: boolean; canEdit?: boolean }>;
    isPersonal?: boolean;
  };
  if (!name?.trim()) return NextResponse.json({ error: "Название роли обязательно." }, { status: 400 });

  const { data: role, error } = await supabaseAdmin
    .from("roles")
    .insert({ name: name.trim(), is_personal: !!isPersonal })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const rows = Object.entries(permissions ?? {}).map(([section, p]) => ({
    role_id: role.id,
    section,
    can_view: caller.isAdmin || !ADMIN_ONLY_SECTIONS.includes(section) ? !!p.canView : false,
    can_edit: caller.isAdmin || !ADMIN_ONLY_SECTIONS.includes(section) ? !!p.canEdit : false,
  }));
  if (rows.length) {
    const { error: permError } = await supabaseAdmin.from("role_permissions").insert(rows);
    if (permError) return NextResponse.json({ error: permError.message }, { status: 400 });
  }

  return NextResponse.json({ id: role.id });
}
