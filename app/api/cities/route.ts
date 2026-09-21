import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSettingsAccess } from "@/lib/requireAdmin";

export async function GET(request: Request) {
  const caller = await requireSettingsAccess(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from("cities")
    .select("id, name, stores(id, name, code)")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ cities: data });
}

export async function POST(request: Request) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  const body = await request.json();
  const { name } = body as { name?: string };
  if (!name?.trim()) return NextResponse.json({ error: "Название города обязательно." }, { status: 400 });

  const { data, error } = await supabaseAdmin.from("cities").insert({ name: name.trim() }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // A city IS its one point of sale — no separate store management anymore.
  const { error: storeError } = await supabaseAdmin
    .from("stores")
    .insert({ city_id: data.id, name: name.trim(), code: `city_${data.id}` });
  if (storeError) {
    await supabaseAdmin.from("cities").delete().eq("id", data.id);
    return NextResponse.json({ error: storeError.message }, { status: 400 });
  }

  return NextResponse.json({ id: data.id });
}
