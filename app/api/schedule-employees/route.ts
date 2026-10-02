import { NextResponse } from "next/server";
import { requireScheduleAccess } from "@/lib/requireAdmin";
import { listEmployees } from "@/lib/employees";
import { getErrorMessage } from "@/lib/errors";

// Roster for the График смен grid — every current employee, so someone with
// no shifts yet still has a row to assign one to. Separate from
// /api/employees so it only needs "schedule" access, not "settings.employees".
export async function GET(request: Request) {
  const caller = await requireScheduleAccess(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа к разделу «График смен»." }, { status: 403 });

  try {
    const employees = await listEmployees();
    const roster = employees.map((e) => ({ id: e.id, name: e.fullName || e.email }));
    return NextResponse.json({ roster });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
