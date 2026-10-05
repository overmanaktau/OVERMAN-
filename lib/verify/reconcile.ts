// Ночная сверка отчётов: цифры вчерашнего дня в нашей базе сверяются со свежими данными
// МойСклад и между собой (кассы ↔ сотрудники ↔ товары), а ещё проверяется, что отработали
// синхронизация, счётчики трафика и снимок остатков. Результат — одно сообщение владельцу в
// личку: «всё сходится» или «есть расхождения» с цифрами.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  fetchDemandInfo,
  fetchRetailDemandsForDate,
  fetchRetailSalesReturnsForDate,
  fetchReturnedItemsBefore,
} from "@/lib/moysklad";
import { REGISTER_STORE, SAYA_PARK_RETIRED_FROM, registerCounts } from "@/lib/registers";
import { WAREHOUSES } from "@/lib/warehouses";
import { escapeHtml } from "@/lib/telegram";
import { money, num, pre } from "@/lib/reports/sales";

export type Check = { ok: boolean; title: string; detail?: string };
export type ReconcileResult = {
  date: string;
  ok: boolean;
  checks: Check[];
  cities: { code: string; name: string; revenue: number; receipts: number; items: number }[];
};

const CITIES: { code: string; name: string }[] = [
  { code: "point_1", name: "Актау" },
  { code: "point_3", name: "Актобе" },
];
const TRAFFIC_FACT_FROM: Record<string, string> = { point_1: "2000-01-01", point_3: "2026-09-28" }; // Актобе — трафик только с 28.09
const MONEY_TOLERANCE = 1; // ₸

type Totals = { revenue: number; receipts: number; items: number };
const empty = (): Totals => ({ revenue: 0, receipts: 0, items: 0 });

// Выручка, чеки и товары по городам прямо из МойСклад — по тем же правилам, что и синхронизация
// (возвраты вычитаются в день возврата; чек аннулируется, если вернули всё, что в нём было).
async function freshFromMoysklad(date: string): Promise<Record<string, Totals>> {
  const demands = await fetchRetailDemandsForDate(date);
  const returns = await fetchRetailSalesReturnsForDate(date);
  const byCity: Record<string, Totals> = {};
  const of = (city: string) => (byCity[city] ??= empty());

  for (const d of demands) {
    const id = d.retailStore?.id;
    if (!id || !registerCounts(id, date)) continue;
    const t = of(REGISTER_STORE[id]);
    t.revenue += (d.sum ?? 0) / 100;
    t.receipts += 1;
    t.items += (d.positions?.rows ?? []).reduce((a, p) => a + (p.quantity ?? 0), 0);
  }
  for (const r of returns) {
    const id = r.retailStore?.id;
    if (!id || !registerCounts(id, date)) continue;
    const t = of(REGISTER_STORE[id]);
    const rItems = (r.positions?.rows ?? []).reduce((a, p) => a + (p.quantity ?? 0), 0);
    t.revenue -= (r.sum ?? 0) / 100;
    t.items -= rItems;
    const href = r.demand?.meta?.href;
    if (href) {
      const { items: original, moment } = await fetchDemandInfo(href);
      const before = await fetchReturnedItemsBefore(href, moment, r);
      if (original > 0 && before < original && before + rItems >= original) t.receipts -= 1;
    }
  }
  return byCity;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function reconcileDay(date: string): Promise<ReconcileResult> {
  const checks: Check[] = [];
  const push = (ok: boolean, title: string, detail?: string) => checks.push({ ok, title, detail });

  // 1. Что в нашей базе по кассам (по городам)
  const { data: regRows, error: regError } = await supabaseAdmin
    .from("moysklad_sales_daily")
    .select("revenue, receipts_count, items_count, moysklad_registers(store)")
    .eq("sale_date", date);
  if (regError) throw regError;
  const db: Record<string, Totals> = {};
  for (const row of (regRows ?? []) as unknown as {
    revenue: number;
    receipts_count: number;
    items_count: number;
    moysklad_registers: { store: string | null } | { store: string | null }[] | null;
  }[]) {
    const reg = Array.isArray(row.moysklad_registers) ? row.moysklad_registers[0] : row.moysklad_registers;
    if (!reg?.store) continue;
    const t = (db[reg.store] ??= empty());
    t.revenue += Number(row.revenue) || 0;
    t.receipts += Number(row.receipts_count) || 0;
    t.items += Number(row.items_count) || 0;
  }

  // 2. Свежие данные МойСклад и сравнение с базой
  const fresh = await freshFromMoysklad(date);
  for (const c of CITIES) {
    const a = db[c.code] ?? empty();
    const b = fresh[c.code] ?? empty();
    const diffs: string[] = [];
    if (Math.abs(a.revenue - b.revenue) > MONEY_TOLERANCE) diffs.push(`выручка: в базе ${money(a.revenue)}, в МойСклад ${money(b.revenue)}`);
    if (a.receipts !== b.receipts) diffs.push(`чеков: в базе ${num(a.receipts)}, в МойСклад ${num(b.receipts)}`);
    if (Math.abs(a.items - b.items) > 0.001) diffs.push(`товаров: в базе ${num(a.items)}, в МойСклад ${num(b.items)}`);
    push(diffs.length === 0, `${c.name}: продажи совпадают с МойСклад`, diffs.join("; "));
  }

  // 3. Внутренняя согласованность: сотрудники и товары против касс
  const { data: empRows, error: empError } = await supabaseAdmin
    .from("moysklad_employee_sales_daily")
    .select("store, revenue, receipts_count, items_count")
    .eq("sale_date", date);
  if (empError) throw empError;
  const emp: Record<string, Totals> = {};
  for (const r of (empRows ?? []) as { store: string; revenue: number; receipts_count: number; items_count: number }[]) {
    const t = (emp[r.store] ??= empty());
    t.revenue += Number(r.revenue) || 0;
    t.receipts += Number(r.receipts_count) || 0;
    t.items += Number(r.items_count) || 0;
  }
  const { data: prodRows, error: prodError } = await supabaseAdmin
    .from("moysklad_product_sales_daily")
    .select("store, revenue")
    .eq("sale_date", date);
  if (prodError) throw prodError;
  const prod: Record<string, number> = {};
  for (const r of (prodRows ?? []) as { store: string; revenue: number }[]) prod[r.store] = (prod[r.store] ?? 0) + (Number(r.revenue) || 0);

  for (const c of CITIES) {
    const reg = db[c.code] ?? empty();
    const e = emp[c.code] ?? empty();
    const diffs: string[] = [];
    if (Math.abs(reg.revenue - e.revenue) > MONEY_TOLERANCE) diffs.push(`выручка: кассы ${money(reg.revenue)}, сотрудники ${money(e.revenue)}`);
    if (reg.receipts !== e.receipts) diffs.push(`чеков: кассы ${num(reg.receipts)}, сотрудники ${num(e.receipts)}`);
    if (Math.abs(reg.items - e.items) > 0.001) diffs.push(`товаров: кассы ${num(reg.items)}, сотрудники ${num(e.items)}`);
    push(diffs.length === 0, `${c.name}: кассы равны сумме по сотрудникам`, diffs.join("; "));

    // Склады города; Saya Park после 21.09 в продажи не входит.
    const codes = WAREHOUSES.filter((w) => w.cityCode === c.code && !(w.code === "saya_park" && date >= SAYA_PARK_RETIRED_FROM)).map((w) => w.code);
    const productRevenue = codes.reduce((a, code) => a + (prod[code] ?? 0), 0);
    const hasProducts = codes.some((code) => prod[code] !== undefined);
    if (reg.revenue === 0 && !hasProducts) {
      push(true, `${c.name}: продажи по товарам равны кассам`);
    } else {
      const ok = Math.abs(reg.revenue - productRevenue) <= 5;
      push(ok, `${c.name}: продажи по товарам равны кассам`, ok ? "" : `кассы ${money(reg.revenue)}, по товарам ${money(productRevenue)}`);
    }
  }

  // 4. Трафик за вчера загружен (счётчики)
  const { data: trafficRows, error: trafficError } = await supabaseAdmin
    .from("traffic_entries")
    .select("store, traffic_fact")
    .eq("entry_date", date);
  if (trafficError) throw trafficError;
  for (const c of CITIES) {
    if (date < TRAFFIC_FACT_FROM[c.code]) continue;
    const row = (trafficRows ?? []).find((r) => r.store === c.code);
    const ok = !!row && row.traffic_fact !== null;
    push(ok, `${c.name}: трафик за день загружен`, ok ? "" : "факта трафика за этот день нет — не отработала автозагрузка со счётчиков");
  }

  // 5. Снимок остатков за вчера и состояние синхронизации
  const { count: snapRows, error: snapError } = await supabaseAdmin
    .from("moysklad_stock_snapshot_daily")
    .select("snapshot_date", { count: "exact", head: true })
    .eq("snapshot_date", date);
  if (snapError) throw snapError;
  push((snapRows ?? 0) > 0, "Снимок остатков за день сохранён", (snapRows ?? 0) > 0 ? "" : "снимка нет — оборачиваемость за этот день считается без него");

  const { data: syncState } = await supabaseAdmin.from("moysklad_sync_state").select("last_synced_at, last_status, last_error").eq("id", true).maybeSingle();
  const lastSync = syncState?.last_synced_at ? new Date(syncState.last_synced_at).getTime() : 0;
  const fresh26 = Date.now() - lastSync < 26 * 3600 * 1000;
  const syncOk = syncState?.last_status === "ok" && fresh26;
  push(
    syncOk,
    "Ночная синхронизация МойСклад отработала",
    syncOk ? "" : `статус «${syncState?.last_status ?? "нет данных"}»${fresh26 ? "" : ", последний запуск был больше 26 часов назад"}${syncState?.last_error ? `: ${syncState.last_error}` : ""}`
  );

  return {
    date,
    ok: checks.every((c) => c.ok),
    checks,
    cities: CITIES.map((c) => ({ code: c.code, name: c.name, ...(db[c.code] ?? empty()) })),
  };
}

function shortDate(d: string): string {
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y}`;
}

// Текст сообщения владельцу.
export function reconcileMessage(r: ReconcileResult): string {
  const title = r.ok ? `✅ <b>Сверка за ${shortDate(r.date)}: всё сходится</b>` : `⚠️ <b>Сверка за ${shortDate(r.date)}: есть расхождения</b>`;
  const lines = r.cities.map((c) => `${c.name}: ${money(c.revenue)} · ${num(c.receipts)} чек. · ${num(c.items)} тов.`);
  const bad = r.checks.filter((c) => !c.ok);
  if (r.ok) {
    return `${title}\n${pre(lines.join("\n"))}\nПроверено: продажи с МойСклад, кассы и сотрудники, товары, возвраты, трафик, остатки, синхронизация (${r.checks.length} проверок).`;
  }
  const problems = bad.map((c) => `• <b>${escapeHtml(c.title)}</b>${c.detail ? `\n  ${escapeHtml(c.detail)}` : ""}`).join("\n");
  return `${title}\n${pre(lines.join("\n"))}\n${problems}\n\nОстальные проверки (${r.checks.length - bad.length} из ${r.checks.length}) в порядке. Отчёты в группы уходят как обычно.`;
}

export { addDays };
