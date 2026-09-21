import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Только администратор может подтверждать запросы." }, { status: 403 });

  const { data: req, error: fetchError } = await supabaseAdmin
    .from("edit_requests")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 400 });
  if (!req) return NextResponse.json({ error: "Запрос не найден." }, { status: 404 });
  if (req.status !== "pending") return NextResponse.json({ error: "Запрос уже обработан." }, { status: 400 });

  const { error: unlockError } = await supabaseAdmin
    .from(req.table_name)
    .update({ locked: false })
    .eq("id", req.row_id);
  if (unlockError) return NextResponse.json({ error: unlockError.message }, { status: 400 });

  const { error: statusError } = await supabaseAdmin
    .from("edit_requests")
    .update({ status: "approved", reviewed_at: new Date().toISOString() })
    .eq("id", req.id);
  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
