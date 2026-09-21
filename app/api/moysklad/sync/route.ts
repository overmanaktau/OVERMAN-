import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { fetchRetailDemandsForDate, fetchRetailSalesReturnsForDate } from "@/lib/moysklad";

// Confirmed with the business owner: these are the only live registers
// (МойСклад entity/retailstore, "точки продаж" — not "склад", which
// doesn't carry the city in its name). "Онлайн продажи Overman" and
// "Ак Кала" are inactive retailstore entries and get skipped.
const REGISTER_STORE: Record<string, string> = {
  "01e67f9f-b012-11f0-0a80-0d700024a20d": "point_1", // Overman Актау
  "d3f209de-4da2-11f0-0a80-027a0003cde2": "point_1", // Saya Park
  "26e2dddd-a37f-11f1-0a80-1a76002585af": "point_3", // Overman Актобе
  "111827a0-a440-11f1-0a80-0dcb003111ce": "point_3", // Актобе скидка
};

function yesterdayInAlmaty(): string {
  // Kazakhstan runs on a single UTC+5 zone (Asia/Almaty covers it, no DST) —
  // the server itself runs in UTC, so "yesterday" has to be computed in
  // that local zone, not the server's own date.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const localToday = new Date(Date.UTC(y, m - 1, d));
  localToday.setUTCDate(localToday.getUTCDate() - 1);
  return localToday.toISOString().slice(0, 10);
}

async function runSync(date: string) {
  const [demands, returns] = await Promise.all([
    fetchRetailDemandsForDate(date),
    fetchRetailSalesReturnsForDate(date),
  ]);

  const byRegister = new Map<string, { name: string; revenue: number; receipts: number; items: number }>();
  for (const d of demands) {
    const id = d.retailStore?.id;
    const name = d.retailStore?.name;
    if (!id || !name || !REGISTER_STORE[id]) continue; // not a live retail register
    const agg = byRegister.get(id) ?? { name, revenue: 0, receipts: 0, items: 0 };
    agg.revenue += (d.sum ?? 0) / 100;
    agg.receipts += 1;
    agg.items += (d.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
    byRegister.set(id, agg);
  }

  // A return always references an existing check (via "demand") — it's an
  // adjustment to that sale, not a check of its own, so it subtracts from
  // revenue and item count but never touches receipts_count.
  let returnedAmount = 0;
  for (const r of returns) {
    const id = r.retailStore?.id;
    const name = r.retailStore?.name;
    if (!id || !name || !REGISTER_STORE[id]) continue;
    const agg = byRegister.get(id) ?? { name, revenue: 0, receipts: 0, items: 0 };
    agg.revenue -= (r.sum ?? 0) / 100;
    agg.items -= (r.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
    byRegister.set(id, agg);
    returnedAmount += (r.sum ?? 0) / 100;
  }

  const skipped = demands.length - [...byRegister.values()].reduce((acc, r) => acc + r.receipts, 0);

  for (const [id, agg] of byRegister) {
    const { error: registerError } = await supabaseAdmin
      .from("moysklad_registers")
      .upsert({ id, name: agg.name, store: REGISTER_STORE[id] }, { onConflict: "id", ignoreDuplicates: false });
    if (registerError) throw registerError;

    const { error: salesError } = await supabaseAdmin.from("moysklad_sales_daily").upsert(
      {
        register_id: id,
        sale_date: date,
        revenue: agg.revenue,
        receipts_count: agg.receipts,
        items_count: agg.items,
      },
      { onConflict: "register_id,sale_date" }
    );
    if (salesError) throw salesError;
  }

  return {
    date,
    registers: byRegister.size,
    receipts: demands.length,
    returns: returns.length,
    returnedAmount,
    skipped,
  };
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? yesterdayInAlmaty();

  try {
    const result = await runSync(date);
    await supabaseAdmin
      .from("moysklad_sync_state")
      .update({ last_synced_at: new Date().toISOString(), last_status: "ok", last_error: null })
      .eq("id", true);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabaseAdmin
      .from("moysklad_sync_state")
      .update({ last_synced_at: new Date().toISOString(), last_status: "error", last_error: message })
      .eq("id", true);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
