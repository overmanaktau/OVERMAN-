// Годовой LTV по городам: сколько раз в среднем покупает у нас один клиент за последние 365 дней.
// Клиент — покупатель в чеке, кроме «Розничного покупателя» (чеки без регистрации в LTV не входят). Считается по чекам МойСклад
// и записывается в client_ltv_year (читает страница «Продажа»); пересчёт — каждую ночь, от выбранного на сайте периода не зависит.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchClientChecksForRange, fetchRetailBuyerIds } from "@/lib/moysklad";
import { registerCounts, REGISTER_STORE } from "@/lib/registers";
import { todayAlmaty } from "@/lib/kassa/sync";

export const LTV_DAYS = 365;

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function refreshYearLtv(): Promise<{ from: string; to: string; checks: number; cities: Record<string, { clients: number; purchases: number }> }> {
  const to = todayAlmaty();
  const from = addDays(to, -(LTV_DAYS - 1));
  const [checks, retailIds] = await Promise.all([fetchClientChecksForRange(from, to), fetchRetailBuyerIds()]);

  const byCity = new Map<string, { clients: Set<string>; purchases: number }>();
  for (const c of checks) {
    const city = REGISTER_STORE[c.retailStoreId];
    if (!city || !registerCounts(c.retailStoreId, c.moment.slice(0, 10))) continue;
    if (!c.agentId || retailIds.has(c.agentId)) continue;
    const agg = byCity.get(city) ?? { clients: new Set<string>(), purchases: 0 };
    agg.clients.add(c.agentId);
    agg.purchases++;
    byCity.set(city, agg);
  }

  const now = new Date().toISOString();
  const cities: Record<string, { clients: number; purchases: number }> = {};
  for (const city of new Set(Object.values(REGISTER_STORE))) {
    const agg = byCity.get(city);
    const row = { store: city, period_from: from, period_to: to, clients: agg?.clients.size ?? 0, purchases: agg?.purchases ?? 0, computed_at: now };
    const { error } = await supabaseAdmin.from("client_ltv_year").upsert(row, { onConflict: "store" });
    if (error) throw error;
    cities[city] = { clients: row.clients, purchases: row.purchases };
  }
  return { from, to, checks: checks.length, cities };
}
