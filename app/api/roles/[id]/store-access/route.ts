import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from("role_store_access")
    .select("scope, city_id, store_id")
    .eq("role_id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ grants: data });
}

type Grant = { scope: "all" | "city" | "store"; cityId?: number | null; storeId?: number | null };

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const body = await request.json();
  const { grants } = body as { grants?: Grant[] };

  const roleId = Number(params.id);

  const { error: deleteError } = await supabaseAdmin.from("role_store_access").delete().eq("role_id", roleId);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 400 });

  const rows = (grants ?? []).map((g) => ({
    role_id: roleId,
    scope: g.scope,
    city_id: g.scope === "city" ? g.cityId ?? null : null,
    store_id: g.scope === "store" ? g.storeId ?? null : null,
  }));

  if (rows.length) {
    const { error: insertError } = await supabaseAdmin.from("role_store_access").insert(rows);
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
