import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { syncKassaClients } from "@/lib/kassa/sync";

export const maxDuration = 300;

// Ночная загрузка клиентов для кассы (pg_cron, после основной синхронизации) или вручную админом.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  try {
    return NextResponse.json({ ok: true, ...(await syncKassaClients()) });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
