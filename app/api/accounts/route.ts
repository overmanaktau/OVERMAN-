import { NextResponse } from "next/server";
import { requireAccountsAccess } from "@/lib/requireAdmin";
import { listEmployees } from "@/lib/employees";
import { getErrorMessage } from "@/lib/errors";

export async function GET(request: Request) {
  const caller = await requireAccountsAccess(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «Аккаунты»." }, { status: 403 });

  try {
    const employees = await listEmployees();
    return NextResponse.json({ employees });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
