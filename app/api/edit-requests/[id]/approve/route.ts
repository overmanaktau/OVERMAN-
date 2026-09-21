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

  const unlockExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  let targetRowId: number = req.row_id;

  if (targetRowId == null) {
    // First-time entry on a date outside the free yesterday/today window —
    // there's no row yet, so create a blank one, already unlocked and
    // time-boxed, for the employee to fill in.
    if (!req.entry_date) {
      return NextResponse.json({ error: "В заявке не указана дата строки." }, { status: 400 });
    }
    const inserted =
      req.table_name === "traffic_entries"
        ? await supabaseAdmin
            .from("traffic_entries")
            .insert({ store: req.store, entry_date: req.entry_date, locked: false, unlock_expires_at: unlockExpiresAt })
            .select("id")
            .single()
        : await supabaseAdmin
            .from("extra_expenses")
            .insert({ expense_date: req.entry_date, category: "", amount: 0, comment: "", locked: false, unlock_expires_at: unlockExpiresAt })
            .select("id")
            .single();
    if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 400 });
    targetRowId = inserted.data.id;
  } else {
    const { error: unlockError } = await supabaseAdmin
      .from(req.table_name)
      .update({ locked: false, unlock_expires_at: unlockExpiresAt })
      .eq("id", targetRowId);
    if (unlockError) return NextResponse.json({ error: unlockError.message }, { status: 400 });
  }

  const { data: reviewerRole } = await supabaseAdmin
    .from("user_roles")
    .select("full_name")
    .eq("user_id", caller.user.id)
    .maybeSingle();

  const { error: statusError } = await supabaseAdmin
    .from("edit_requests")
    .update({
      status: "approved",
      row_id: targetRowId,
      reviewed_at: new Date().toISOString(),
      reviewed_by: caller.user.id,
      reviewed_by_name: reviewerRole?.full_name || caller.user.email,
    })
    .eq("id", req.id);
  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
