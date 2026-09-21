import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Только администратор может отклонять запросы." }, { status: 403 });

  const { data: req, error: fetchError } = await supabaseAdmin
    .from("edit_requests")
    .select("id, status")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 400 });
  if (!req) return NextResponse.json({ error: "Запрос не найден." }, { status: 404 });
  if (req.status !== "pending") return NextResponse.json({ error: "Запрос уже обработан." }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("edit_requests")
    .update({ status: "denied", reviewed_at: new Date().toISOString() })
    .eq("id", req.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
