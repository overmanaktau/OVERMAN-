import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { refreshYearLtv } from "@/lib/ltvYear";

export const maxDuration = 300;

// Пересчёт годового LTV по городам (pg_cron каждую ночь). Только с CRON_SECRET.
export async function GET(request: Request) {
  const cron = process.env.CRON_SECRET;
  if (!cron || (request.headers.get("authorization") ?? "") !== `Bearer ${cron}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  try {
    const started = Date.now();
    const result = await refreshYearLtv();
    return NextResponse.json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), ...result });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
