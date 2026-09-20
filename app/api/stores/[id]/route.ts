import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSettingsAccess } from "@/lib/requireAdmin";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  const body = await request.json();
  const { name, cityId } = body as { name?: string; cityId?: number };

  const payload: Record<string, unknown> = {};
  if (name !== undefined) payload.name = name.trim();
  if (cityId !== undefined) payload.city_id = cityId;

  const { error } = await supabaseAdmin.from("stores").update(payload).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireSettingsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Сотрудники и доступы»." }, { status: 403 });

  const { error } = await supabaseAdmin.from("stores").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
