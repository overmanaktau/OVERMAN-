import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireRequestsAccess } from "@/lib/requireAdmin";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireRequestsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Запросы»." }, { status: 403 });

  const { data: req, error: fetchError } = await supabaseAdmin
    .from("edit_requests")
    .select("id, status")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 400 });
  if (!req) return NextResponse.json({ error: "Запрос не найден." }, { status: 404 });
  if (req.status !== "pending") return NextResponse.json({ error: "Запрос уже обработан." }, { status: 400 });

  const { data: reviewerRole } = await supabaseAdmin
    .from("user_roles")
    .select("full_name")
    .eq("user_id", caller.user.id)
    .maybeSingle();

  const { error } = await supabaseAdmin
    .from("edit_requests")
    .update({
      status: "denied",
      reviewed_at: new Date().toISOString(),
      reviewed_by: caller.user.id,
      reviewed_by_name: reviewerRole?.full_name || caller.user.email,
    })
    .eq("id", req.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
