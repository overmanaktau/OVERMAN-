import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireRequestsAccess } from "@/lib/requireAdmin";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireRequestsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Запросы»." }, { status: 403 });

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

  const { data: reviewerRole } = await supabaseAdmin
    .from("user_roles")
    .select("full_name")
    .eq("user_id", caller.user.id)
    .maybeSingle();

  const { error: statusError } = await supabaseAdmin
    .from("edit_requests")
    .update({
      status: "approved",
      reviewed_at: new Date().toISOString(),
      reviewed_by: caller.user.id,
      reviewed_by_name: reviewerRole?.full_name || caller.user.email,
    })
    .eq("id", req.id);
  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
