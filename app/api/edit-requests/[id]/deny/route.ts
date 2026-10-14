import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireRequestsAccess } from "@/lib/requireAdmin";
import { denyEditRequest } from "@/lib/editRequests";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireRequestsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Запросы»." }, { status: 403 });

  const { data: reviewerRole } = await supabaseAdmin.from("user_roles").select("full_name").eq("user_id", caller.user.id).maybeSingle();
  const res = await denyEditRequest(Number(params.id), { id: caller.user.id, name: reviewerRole?.full_name || caller.user.email || "" });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true });
}
