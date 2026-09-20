import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSettingsAccess } from "@/lib/requireAdmin";

export async function POST(request: Request) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  const body = await request.json();
  const { cityId, name, code } = body as { cityId?: number; name?: string; code?: string };
  if (!cityId || !name?.trim() || !code?.trim()) {
    return NextResponse.json({ error: "Город, название и код точки обязательны." }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("stores")
    .insert({ city_id: cityId, name: name.trim(), code: code.trim() })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ id: data.id });
}
