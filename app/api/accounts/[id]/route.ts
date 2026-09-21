import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAccountsAccess } from "@/lib/requireAdmin";
import { deleteEmployeeAccount } from "@/lib/employees";

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireAccountsAccess(request, "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Аккаунты»." }, { status: 403 });

  if (params.id === caller.user.id) {
    return NextResponse.json({ error: "Нельзя удалить самого себя." }, { status: 400 });
  }

  if (!caller.isAdmin) {
    const { data: targetRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", params.id)
      .maybeSingle();
    if (targetRole?.role === "admin") {
      return NextResponse.json({ error: "Удалять администраторов может только администратор." }, { status: 403 });
    }
  }

  const result = await deleteEmployeeAccount(params.id);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true });
}
