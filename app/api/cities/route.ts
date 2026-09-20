import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function GET(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from("cities")
    .select("id, name, stores(id, name, code)")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ cities: data });
}

export async function POST(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Доступ только для администратора." }, { status: 403 });

  const body = await request.json();
  const { name } = body as { name?: string };
  if (!name?.trim()) return NextResponse.json({ error: "Название города обязательно." }, { status: 400 });

  const { data, error } = await supabaseAdmin.from("cities").insert({ name: name.trim() }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ id: data.id });
}
