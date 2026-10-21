// Состояние начислений портала для расчёта бонусов клиента (см. lib/kassa/accrual.ts):
//  · pending — бонусы за недавние покупки, которые ещё не зачислены в МойСклад (клиент → [{дата покупки, сумма, чек}]);
//  · txDemand — зачисленная порталом операция МойСклад → чек, за который она начислена (чтобы партия и возврат находили свою покупку).
// Отдельный файл, чтобы расчёт клиента (clientSync) мог их читать, не завися от самого начисления.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { BonusTx } from "@/lib/kassa/bonus";

export type PendingBonus = { date: string; amount: number; demandId: string };
export type AccrualState = { pending: Map<string, PendingBonus[]>; txDemand: Map<string, string> };

export async function loadAccrualState(clientIds?: string[]): Promise<AccrualState> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const since = new Date(new Date(`${today}T00:00:00Z`).getTime() - 130 * 86400000).toISOString().slice(0, 10);
  let q = supabaseAdmin.from("bonus_accruals").select("demand_id, client_ms_id, purchase_date, amount, credited, tx_id").gte("purchase_date", since);
  if (clientIds && clientIds.length > 0) q = q.in("client_ms_id", clientIds);
  const { data, error } = await q.limit(30000);
  if (error) throw error;
  const pending = new Map<string, PendingBonus[]>();
  const txDemand = new Map<string, string>();
  for (const r of (data ?? []) as { demand_id: string; client_ms_id: string; purchase_date: string; amount: number; credited: number; tx_id: string | null }[]) {
    if (r.tx_id) txDemand.set(r.tx_id, r.demand_id);
    if (r.amount > 0 && r.credited < r.amount) {
      const list = pending.get(r.client_ms_id) ?? [];
      list.push({ date: r.purchase_date, amount: r.amount - r.credited, demandId: r.demand_id });
      pending.set(r.client_ms_id, list);
    }
  }
  return { pending, txDemand };
}

// Операции МойСклад, зачисленные порталом, получают чек-основание — как у начислений самой программы.
export function linkAccrualTx<T extends BonusTx>(txs: T[], txDemand: Map<string, string>): T[] {
  return txs.map((t) => (txDemand.has(t.id) && !t.parentId ? { ...t, parentType: "retaildemand", parentId: txDemand.get(t.id) as string } : t));
}
