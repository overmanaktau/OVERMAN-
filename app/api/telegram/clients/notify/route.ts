import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { runDailyClientMessages } from "@/lib/clientBotNotify";

export const maxDuration = 300;

// Ежедневные сообщения клиентам о бонусах: активация, скорое сгорание, сгорание (pg_cron утром по Алматы).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  try {
    return NextResponse.json({ ok: true, ...(await runDailyClientMessages()) });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
