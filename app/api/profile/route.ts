import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Self-service rename: any authenticated user with the "profile.rename" edit
// permission (admins always have it) can change their own display name.
export async function PATCH(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Не авторизован." }, { status: 401 });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData.user) return NextResponse.json({ error: "Не авторизован." }, { status: 401 });

  const { data: roleRow, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role, role_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (roleError) return NextResponse.json({ error: roleError.message }, { status: 500 });

  let allowed = roleRow?.role === "admin";
  if (!allowed && roleRow?.role_id) {
    const { data: permRow } = await supabaseAdmin
      .from("role_permissions")
      .select("can_edit")
      .eq("role_id", roleRow.role_id)
      .eq("section", "profile.rename")
      .maybeSingle();
    allowed = !!permRow?.can_edit;
  }
  if (!allowed) return NextResponse.json({ error: "Нет прав на смену имени." }, { status: 403 });

  const body = await request.json();
  const { fullName } = body as { fullName?: string };
  const clean = fullName?.trim() || null;

  const { error } = await supabaseAdmin.from("user_roles").update({ full_name: clean }).eq("user_id", userData.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ fullName: clean });
}
