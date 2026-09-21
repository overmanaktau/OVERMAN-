import { NextResponse } from "next/server";
import { requireHistoryAccess } from "@/lib/requireAdmin";
import { listEmployees } from "@/lib/employees";
import { getErrorMessage } from "@/lib/errors";

// A lightweight name-only roster for the История page's employee filter, so
// every current employee shows up as a filter option — not just the ones who
// already have logged edits. Separate from /api/employees so it only needs
// "history" access, not "settings.employees".
export async function GET(request: Request) {
  const caller = await requireHistoryAccess(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «История»." }, { status: 403 });

  try {
    const employees = await listEmployees();
    const names = employees.map((e) => e.fullName || e.email);
    return NextResponse.json({ names });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
