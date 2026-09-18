import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function GET(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from("roles")
    .select("id, name, role_permissions(section, can_view, can_edit)")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ roles: data });
}

export async function POST(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const body = await request.json();
  const { name, permissions } = body as {
    name?: string;
    permissions?: Record<string, { canView?: boolean; canEdit?: boolean }>;
  };
  if (!name?.trim()) return NextResponse.json({ error: "Название роли обязательно." }, { status: 400 });

  const { data: role, error } = await supabaseAdmin.from("roles").insert({ name: name.trim() }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const rows = Object.entries(permissions ?? {}).map(([section, p]) => ({
    role_id: role.id,
    section,
    can_view: !!p.canView,
    can_edit: !!p.canEdit,
  }));
  if (rows.length) {
    const { error: permError } = await supabaseAdmin.from("role_permissions").insert(rows);
    if (permError) return NextResponse.json({ error: permError.message }, { status: 400 });
  }

  return NextResponse.json({ id: role.id });
}
