import { NextResponse } from "next/server";
import { requireHistoryAccess } from "@/lib/requireAdmin";
import { listEmployees } from "@/lib/employees";
import { getErrorMessage } from "@/lib/errors";

// A lightweight roster for the История page's employee filter: every current
// employee shows up as a filter option (not just ones with logged edits),
// and — via id, not just name — lets old rows resolve to a renamed
// employee's CURRENT name instead of staying stuck under whatever name was
// stored on them at write time. Separate from /api/employees so it only
// needs "history" access, not "settings.employees".
export async function GET(request: Request) {
  const caller = await requireHistoryAccess(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «История»." }, { status: 403 });

  try {
    const employees = await listEmployees();
    const roster = employees.map((e) => ({ id: e.id, name: e.fullName || e.email }));
    return NextResponse.json({ roster });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
