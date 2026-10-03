import { NextResponse } from "next/server";
import { requireSectionAccess } from "@/lib/requireAdmin";
import { fetchActiveEmployeeIds } from "@/lib/moysklad";
import { getErrorMessage } from "@/lib/errors";

// Активные сотрудники МойСклад — страница «Продажа» оставляет в списке для
// внесения плана только их. Токен МойСклад остаётся на сервере.
export async function GET(request: Request) {
  const caller = await requireSectionAccess(request, "marketing.statistics", "view");
  if (!caller) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json({ activeIds: await fetchActiveEmployeeIds() });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 502 });
  }
}
