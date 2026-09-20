import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const body = await request.json();
  const { name } = body as { name?: string };
  if (!name?.trim()) return NextResponse.json({ error: "Название города обязательно." }, { status: 400 });

  const { error } = await supabaseAdmin.from("cities").update({ name: name.trim() }).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  // Deleting a city cascades onto its stores and any role access grants pointing at them.
  const { error } = await supabaseAdmin.from("cities").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
