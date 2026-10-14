import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { refreshStockOnly } from "@/lib/stockSync";

export const maxDuration = 300;

// Частое обновление остатков в течение дня (pg_cron каждые 30 минут в рабочее время): остатки на сайте идут «по факту», как в МойСклад,
// а не на момент ночной синхронизации. Обновляются только остатки (по складам, с минусами); каталог, приёмки и история — ночью.
// ?force=1 — не пропускать, даже если остатки обновлялись недавно. Только с CRON_SECRET.
export async function GET(request: Request) {
  const cron = process.env.CRON_SECRET;
  if (!cron || (request.headers.get("authorization") ?? "") !== `Bearer ${cron}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    if (!force) {
      // не обновляем чаще, чем раз в 10 минут (параллельные запуски и ночная синхронизация не мешают друг другу)
      const { data } = await supabaseAdmin.from("moysklad_product_stock").select("synced_at").order("synced_at", { ascending: false }).limit(1).maybeSingle();
      const last = data?.synced_at ? new Date(data.synced_at as string).getTime() : 0;
      if (Date.now() - last < 10 * 60 * 1000) return NextResponse.json({ ok: true, skipped: "остатки обновлялись меньше 10 минут назад" });
    }
    const started = Date.now();
    const result = await refreshStockOnly();
    return NextResponse.json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), ...result });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
