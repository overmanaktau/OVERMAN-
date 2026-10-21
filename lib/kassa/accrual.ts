// Начисление бонусов за покупку силами портала (решение владельца 21.10.2026). МойСклад начисляет сразу и не умеет «через 14 дней» — поэтому после перехода
// начисление в программе «5% OVER» отключено, а бонус портал зачисляет в МойСклад сам, когда проходит срок активации (14 дней со дня покупки).
//  · Чек → строка bonus_accruals: amount = 5% от суммы чека за вычетом возвратов (вниз; так же считает МойСклад: 35 724 ₸ → 1 786).
//  · Возврат или правка чека пересчитывают amount; в день активации задание зачисляет разницу (amount − credited) в МойСклад. Если после зачисления сумма
//    уменьшилась (возврат), лишнее списывается.
//  · Операцию в МойСклад создаём с моментом покупки — тогда срок сгорания (4 месяца) считается от покупки, как и раньше.
//  · Пока бонус не зачислен, на портале и в боте он показывается как «ожидает активации» (loadPending → computeBonus).
// Пока в moysklad_sync_state.accrual_start пусто, всё это ничего не делает.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { createBonusEarning, createBonusWriteOff, fetchDemandForAccrual, fetchReturnedSumForDemand } from "@/lib/moysklad";
import { ACTIVATION_DAYS, almatyDate } from "@/lib/kassa/bonus";
import { syncOneClient } from "@/lib/kassa/clientSync";
import { todayAlmaty } from "@/lib/kassa/sync";
import { retry429 } from "@/lib/kassa/retry";

export const ACCRUAL_RATE = 0.05; // earnRateRoublesToPoint = 20 в программе «5% OVER»
export const accrualAmount = (netSum: number) => Math.max(0, Math.floor(netSum * ACCRUAL_RATE + 1e-9));

const plusDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
// момент в формате МойСклад («ГГГГ-ММ-ДД ЧЧ:ММ:СС», время UTC+3)
const msMoment = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");

export async function accrualStart(): Promise<string | null> {
  const { data } = await supabaseAdmin.from("moysklad_sync_state").select("accrual_start").eq("id", true).maybeSingle();
  return (data?.accrual_start as string | null | undefined) ?? null;
}

// Пересчитать начисление по чеку (после создания, правки, возврата чека).
export async function syncAccrual(demandId: string): Promise<string> {
  const start = await accrualStart();
  if (!start) return "off";
  const d = await fetchDemandForAccrual(demandId);
  if (!d) {
    await supabaseAdmin.from("bonus_accruals").update({ amount: 0, net_sum: 0, updated_at: new Date().toISOString() }).eq("demand_id", demandId); // чек удалили
    return "deleted";
  }
  if (!d.agentId || new Date(d.momentIso) < new Date(start)) return "not-ours"; // до перехода бонус начислил сам МойСклад
  const { data: client } = await supabaseAdmin.from("kassa_clients").select("ms_id").eq("ms_id", d.agentId).maybeSingle();
  if (!client) return "not-client"; // нет в программе (без тега «клиенты» или без телефона)
  const returned = await fetchReturnedSumForDemand(demandId);
  const net = d.active ? Math.max(0, d.sum - returned) : 0;
  const purchaseDate = almatyDate(d.momentIso);
  const { error } = await supabaseAdmin.from("bonus_accruals").upsert(
    {
      demand_id: demandId,
      client_ms_id: d.agentId,
      demand_name: d.name,
      purchase_at: d.momentIso,
      purchase_date: purchaseDate,
      net_sum: net,
      amount: accrualAmount(net),
      activates_on: plusDays(purchaseDate, ACTIVATION_DAYS),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "demand_id" }
  );
  if (error) throw error;
  return "ok";
}

type AccrualRow = { demand_id: string; client_ms_id: string; demand_name: string | null; purchase_at: string; amount: number; credited: number; activates_on: string };

// Зачислить в МойСклад то, что пора (покупка + 14 дней), и поправить зачисленное, если чек изменили. Один поток, в пределах budgetMs.
export async function creditDueAccruals(budgetMs = 230_000): Promise<{ credited: number; adjusted: number; remaining: number; errors: string[] }> {
  const started = Date.now();
  const today = todayAlmaty();
  const { data, error } = await supabaseAdmin
    .from("bonus_accruals")
    .select("demand_id, client_ms_id, demand_name, purchase_at, amount, credited, activates_on")
    .gte("purchase_date", plusDays(today, -130))
    .or(`activates_on.lte.${today},credited.gt.0`)
    .limit(5000);
  if (error) throw error;
  const due = ((data ?? []) as AccrualRow[]).filter((r) => (r.credited < r.amount && r.activates_on <= today) || r.credited > r.amount);
  let credited = 0;
  let adjusted = 0;
  const errors: string[] = [];
  let done = 0;
  for (const r of due) {
    if (Date.now() - started > budgetMs) break;
    done++;
    try {
      const diff = r.amount - r.credited;
      let txId: string | null = null;
      if (diff > 0) {
        const op = await retry429(() => createBonusEarning(r.client_ms_id, diff, `accrual-${r.demand_id}-${r.amount}`, `Бонус за покупку ${r.demand_name ?? ""}`.trim(), msMoment(r.purchase_at)));
        txId = op.id;
        if (r.credited === 0) credited++;
        else adjusted++;
      } else {
        const op = await retry429(() => createBonusWriteOff(r.client_ms_id, -diff, `accrual-adj-${r.demand_id}-${r.amount}`, `Корректировка бонуса за покупку ${r.demand_name ?? ""} (возврат или правка чека)`.trim()));
        txId = op.id;
        adjusted++;
      }
      const { error: upError } = await supabaseAdmin.from("bonus_accruals").update({ credited: r.amount, tx_id: txId, credited_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("demand_id", r.demand_id);
      if (upError) throw upError;
      await retry429(() => syncOneClient(r.client_ms_id)); // в списке портала бонус уже в доступных
    } catch (e) {
      const message = getErrorMessage(e).slice(0, 200);
      errors.push(`${r.demand_name ?? r.demand_id}: ${message}`);
      await supabaseAdmin.from("bonus_accruals").update({ last_error: message, updated_at: new Date().toISOString() }).eq("demand_id", r.demand_id);
    }
  }
  return { credited, adjusted, remaining: due.length - done, errors };
}
