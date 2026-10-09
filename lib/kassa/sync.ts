// Ночная загрузка клиентов для экрана кассы: контрагенты с тегом «клиенты», их покупки (отчёт «Контрагенты»)
// и бонусы по партиям. Только чтение из МойСклад, запись — в таблицы портала (kassa_clients, kassa_bonus_tx).
//
// Бонусные операции МойСклад отдаёт медленно (≈0,3 с на строку), поэтому их копим у себя: первая загрузка идёт
// частями (каждый запуск — в пределах бюджета времени, потом продолжается с места остановки), дальше каждую ночь
// докачиваются только изменившиеся за последние сутки.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllCounterpartiesBasic, fetchBonusTransactionsPage, fetchClientStats, fetchReturnDemandMap, type MsBonusTx } from "@/lib/moysklad";
import { computeBonus, type BonusTx } from "@/lib/kassa/bonus";

export const CLIENT_TAG = "клиенты";
const TX_BUDGET_MS = 140_000;
const PAGE = 100;

export function todayAlmaty(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
}

type TxRow = { ms_id: string; client_ms_id: string; moment: string; kind: string; value: number; status: string; parent_type: string; parent_id: string; updated_at_ms: string };

async function syncBonusTx(): Promise<{ done: boolean; loaded: number }> {
  const { data: st, error } = await supabaseAdmin.from("kassa_sync_state").select("tx_cursor, tx_done").eq("id", true).maybeSingle();
  if (error) throw error;
  // после первичной загрузки берём изменения с запасом в сутки; до неё — продолжаем с сохранённого места
  const startFrom = st?.tx_cursor ? (st.tx_done ? new Date(new Date(st.tx_cursor).getTime() - 24 * 3600 * 1000).toISOString() : st.tx_cursor) : null;
  const started = Date.now();
  let cursor: string | null = st?.tx_cursor ?? null;
  let offset = 0;
  let loaded = 0;
  let done = false;
  for (;;) {
    const rows: MsBonusTx[] = await fetchBonusTransactionsPage(startFrom, offset, PAGE);
    if (rows.length > 0) {
      const batch: TxRow[] = rows.map((r) => ({
        ms_id: r.id,
        client_ms_id: r.clientId,
        moment: r.moment,
        kind: r.kind,
        value: r.value,
        status: r.status,
        parent_type: r.parentType,
        parent_id: r.parentId,
        updated_at_ms: r.updated,
      }));
      const { error: upError } = await supabaseAdmin.from("kassa_bonus_tx").upsert(batch, { onConflict: "ms_id" });
      if (upError) throw upError;
      loaded += rows.length;
      cursor = rows[rows.length - 1].updated;
    }
    if (rows.length < PAGE) {
      done = true;
      break;
    }
    offset += PAGE;
    if (Date.now() - started > TX_BUDGET_MS) break;
  }
  const { error: stError } = await supabaseAdmin
    .from("kassa_sync_state")
    .update({ tx_cursor: cursor, tx_done: done || !!st?.tx_done, last_run_at: new Date().toISOString(), last_error: null })
    .eq("id", true);
  if (stError) throw stError;
  return { done: done || !!st?.tx_done, loaded };
}

export async function syncKassaClients(): Promise<{ clients: number; txLoaded: number; txDone: boolean; withBonus: number; expiredClients: number; expiredTotal: number }> {
  const startedAt = new Date().toISOString();
  const [all, stats] = await Promise.all([fetchAllCounterpartiesBasic(), fetchClientStats()]);
  const clients = all.filter((c) => !c.archived && c.tags.includes(CLIENT_TAG));

  const tx = await syncBonusTx();

  // все операции из своей таблицы
  const byClient = new Map<string, BonusTx[]>();
  let earliest: string | null = null;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("kassa_bonus_tx")
      .select("ms_id, client_ms_id, moment, kind, value, status, parent_type, parent_id")
      .order("ms_id")
      .range(offset, offset + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      const list = byClient.get(r.client_ms_id as string) ?? [];
      list.push({ id: r.ms_id, moment: r.moment, value: Number(r.value), kind: r.kind as "earn" | "spend", status: r.status, parentType: r.parent_type, parentId: r.parent_id });
      byClient.set(r.client_ms_id as string, list);
      if (!earliest || (r.moment as string) < earliest) earliest = r.moment as string;
    }
    if (!data || data.length < 1000) break;
  }
  const hasReturns = [...byClient.values()].some((l) => l.some((t) => t.parentType === "retailsalesreturn"));
  const returnDemand = hasReturns && earliest ? await fetchReturnDemandMap(earliest) : new Map<string, string>();

  const today = todayAlmaty();
  let withBonus = 0;
  let expiredClients = 0;
  let expiredTotal = 0;
  const rows = clients.map((c) => {
    const s = stats.get(c.id);
    const b = computeBonus(byClient.get(c.id) ?? [], returnDemand, today);
    if (b.balance > 0 || b.expired > 0) withBonus += 1;
    if (b.expired > 0) {
      expiredClients += 1;
      expiredTotal += b.expired;
    }
    return {
      ms_id: c.id,
      name: c.name,
      phone: c.phone,
      phone_digits: c.phone.replace(/\D/g, ""),
      tags: c.tags,
      demands_count: s?.demandsCount ?? 0,
      demands_sum: s?.demandsSum ?? 0,
      first_demand_at: s?.firstDemandAt ?? null,
      last_demand_at: s?.lastDemandAt ?? null,
      bonus_balance: b.balance,
      bonus_available: b.available,
      bonus_waiting: b.waiting,
      bonus_next_activation: b.nextActivation,
      bonus_expired: b.expired,
      synced_at: startedAt,
    };
  });

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin.from("kassa_clients").upsert(rows.slice(i, i + 500), { onConflict: "ms_id" });
    if (error) throw error;
  }
  // клиенты, которых больше нет в МойСклад (удалены, в архиве или потеряли тег), из списка кассы убираются
  const { error: delError } = await supabaseAdmin.from("kassa_clients").delete().lt("synced_at", startedAt);
  if (delError) throw delError;
  return { clients: rows.length, txLoaded: tx.loaded, txDone: tx.done, withBonus, expiredClients, expiredTotal };
}
