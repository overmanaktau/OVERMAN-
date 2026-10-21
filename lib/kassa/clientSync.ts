// Обновление одного клиента для экрана /client сразу после его покупки (по уведомлению МойСклад), чтобы данные не ждали ночной загрузки.
// Берёт из МойСклад имя, телефон, чеки и бонусные операции именно этого клиента и пересчитывает бонусы по партиям.
// Только чтение из МойСклад; запись — в таблицы портала (kassa_clients, kassa_bonus_tx).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchClientBasic, fetchClientBonusTransactions, fetchClientDocs } from "@/lib/moysklad";
import { computeBonus } from "@/lib/kassa/bonus";
import { CLIENT_TAG, todayAlmaty } from "@/lib/kassa/sync";

export type OneClientResult = { status: "updated" | "skipped" | "removed"; reason?: string; name?: string };

export async function syncOneClient(clientId: string): Promise<OneClientResult> {
  const client = await fetchClientBasic(clientId);
  if (client && client.phone.replace(/\D/g, "").length < 10) {
    // без телефона (например, «Розничный покупатель» с тысячами чеков) клиента не обновляем: бонусов и Telegram у него быть не может
    return { status: "skipped", reason: "нет телефона" };
  }
  if (!client || client.archived || !client.tags.includes(CLIENT_TAG)) {
    // клиент удалён, в архиве или потерял тег — из списка кассы убираем, если он там был
    const { data } = await supabaseAdmin.from("kassa_clients").delete().eq("ms_id", clientId).select("ms_id");
    return { status: data && data.length > 0 ? "removed" : "skipped", reason: client ? "нет тега" : "клиент не найден" };
  }

  const [tx, docs] = await Promise.all([fetchClientBonusTransactions(clientId), fetchClientDocs(clientId)]);
  if (tx.length > 0) {
    const { error } = await supabaseAdmin.from("kassa_bonus_tx").upsert(
      tx.map((r) => ({ ms_id: r.id, client_ms_id: r.clientId || clientId, moment: r.moment, kind: r.kind, value: r.value, status: r.status, parent_type: r.parentType, parent_id: r.parentId, updated_at_ms: r.updated })),
      { onConflict: "ms_id" }
    );
    if (error) throw error;
  }
  const returnDemand = new Map(docs.returns.filter((r) => r.demandId).map((r) => [r.id, r.demandId as string]));
  const b = computeBonus(
    tx.map((t) => ({ id: t.id, moment: t.moment, value: t.value, kind: t.kind, status: t.status, parentType: t.parentType, parentId: t.parentId })),
    returnDemand,
    todayAlmaty()
  );
  const moments = docs.demands.map((d) => d.moment).sort();
  const { error } = await supabaseAdmin.from("kassa_clients").upsert(
    {
      ms_id: client.id,
      name: client.name,
      phone: client.phone,
      phone_digits: client.phone.replace(/\D/g, ""),
      tags: client.tags,
      demands_count: docs.demands.length,
      demands_sum: docs.demands.reduce((a, d) => a + d.sum, 0),
      first_demand_at: moments[0] ?? null,
      last_demand_at: moments[moments.length - 1] ?? null,
      bonus_balance: b.balance,
      bonus_available: b.available,
      bonus_waiting: b.waiting,
      bonus_next_activation: b.nextActivation,
      bonus_expired: b.expired,
      synced_at: new Date().toISOString(),
    },
    { onConflict: "ms_id" }
  );
  if (error) throw error;
  return { status: "updated", name: client.name };
}
