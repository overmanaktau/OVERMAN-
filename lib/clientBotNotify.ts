// Сообщения клиентам бота о бонусах (@bonus_overman_bot): после покупки, в день активации, за 14 дней до сгорания и в день сгорания. Тексты — lib/clientBotMessages.ts.
// Шлём только подписанным клиентам; повторно одно и то же сообщение не уходит (таблица client_bot_sent).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { telegramClientTransport } from "@/lib/clientBot";
import { getErrorMessage } from "@/lib/errors";
import { fetchClientBonusTransactions, fetchClientDocs } from "@/lib/moysklad";
import { computeBonus } from "@/lib/kassa/bonus";
import { todayAlmaty } from "@/lib/kassa/sync";
import { activatedMessage, expiredMessage, expiringSoonMessage, purchaseMessage } from "@/lib/clientBotMessages";

type Sub = { telegram_user_id: number; telegram_chat_id: number; client_ms_id: string | null };

const ru = (ymd: string) => ymd.split("-").reverse().join(".");
const plusDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

// Подписчики бота с этим номером (по последним 10 цифрам); привязка к клиенту проставляется здесь, если подписались раньше первой покупки.
async function subscribersOf(clientMsId: string, phoneDigits: string): Promise<Sub[]> {
  const last10 = phoneDigits.slice(-10);
  if (last10.length < 10) return [];
  const { data } = await supabaseAdmin.from("client_bot_subscribers").select("telegram_user_id, telegram_chat_id, client_ms_id").eq("status", "active").like("phone_digits", `%${last10}`);
  const subs = (data ?? []) as Sub[];
  for (const s of subs) {
    if (!s.client_ms_id) await supabaseAdmin.from("client_bot_subscribers").update({ client_ms_id: clientMsId }).eq("telegram_user_id", s.telegram_user_id);
  }
  return subs;
}

// Отправка с защитой от повтора; если клиент заблокировал бота — отмечаем это и больше не пишем.
async function sendOnce(clientMsId: string, subs: Sub[], kind: string, ref: string, html: string): Promise<boolean> {
  if (subs.length === 0) return false;
  const { error } = await supabaseAdmin.from("client_bot_sent").insert({ client_ms_id: clientMsId, kind, ref });
  if (error) return false; // уже отправляли (или не удалось записать — лучше промолчать, чем написать дважды)
  let sent = false;
  for (const s of subs) {
    try {
      await telegramClientTransport.send(s.telegram_chat_id, html);
      sent = true;
    } catch (e) {
      if (/blocked|deactivated|chat not found|403/i.test(getErrorMessage(e))) await supabaseAdmin.from("client_bot_subscribers").update({ status: "blocked", blocked_at: new Date().toISOString() }).eq("telegram_user_id", s.telegram_user_id);
      else console.error("client bot send error:", getErrorMessage(e));
    }
  }
  if (!sent) await supabaseAdmin.from("client_bot_sent").delete().eq("client_ms_id", clientMsId).eq("kind", kind).eq("ref", ref);
  return sent;
}

// После покупки: клиент только что пересчитан (syncOneClient). Отправляем по каждой свежей покупке, с которой начислены или списаны бонусы.
export async function notifyAfterPurchase(clientMsId: string): Promise<void> {
  const { data: c } = await supabaseAdmin.from("kassa_clients").select("phone_digits, bonus_available, bonus_waiting").eq("ms_id", clientMsId).maybeSingle();
  if (!c) return;
  const subs = await subscribersOf(clientMsId, String(c.phone_digits ?? ""));
  if (subs.length === 0) return;
  const since = new Date(Date.now() - 36 * 3600000).toISOString();
  const { data: tx } = await supabaseAdmin.from("kassa_bonus_tx").select("kind, value, parent_id, moment").eq("client_ms_id", clientMsId).eq("parent_type", "retaildemand").eq("status", "COMPLETED").gte("moment", since);
  const byDoc = new Map<string, { earned: number; spent: number; moment: string }>();
  for (const t of (tx ?? []) as { kind: string; value: number; parent_id: string; moment: string }[]) {
    const row = byDoc.get(t.parent_id) ?? { earned: 0, spent: 0, moment: t.moment };
    if (t.kind === "earn") row.earned += Number(t.value);
    else row.spent += Number(t.value);
    byDoc.set(t.parent_id, row);
  }
  for (const [docId, d] of byDoc) {
    if (d.earned <= 0 && d.spent <= 0) continue;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date(d.moment));
    await sendOnce(clientMsId, subs, "purchase", docId, purchaseMessage({ earned: d.earned, activatesOn: ru(plusDays(date, 14)), spent: d.spent, available: Number(c.bonus_available), pending: Number(c.bonus_waiting) }));
  }
}

// Ежедневно утром: активация партий сегодня, сгорание через 14 дней и сегодня — для каждого подписанного клиента.
export async function runDailyClientMessages(): Promise<{ clients: number; sent: number }> {
  const today = todayAlmaty();
  const { data } = await supabaseAdmin.from("client_bot_subscribers").select("client_ms_id").eq("status", "active").not("client_ms_id", "is", null);
  const ids = [...new Set((data ?? []).map((r) => r.client_ms_id as string))];
  let sent = 0;
  for (const id of ids) {
    const { data: c } = await supabaseAdmin.from("kassa_clients").select("phone_digits").eq("ms_id", id).maybeSingle();
    if (!c) continue;
    const subs = await subscribersOf(id, String(c.phone_digits ?? ""));
    if (subs.length === 0) continue;
    const [tx, docs] = await Promise.all([fetchClientBonusTransactions(id), fetchClientDocs(id)]);
    const returnDemand = new Map(docs.returns.filter((r) => r.demandId).map((r) => [r.id, r.demandId as string]));
    const b = computeBonus(tx.map((t) => ({ id: t.id, moment: t.moment, value: t.value, kind: t.kind, status: t.status, parentType: t.parentType, parentId: t.parentId })), returnDemand, today);
    const sum = (f: (l: (typeof b.lots)[number]) => boolean) => b.lots.filter((l) => l.remaining > 0 && f(l)).reduce((a, l) => a + l.remaining, 0);
    const activated = sum((l) => l.activatesOn === today);
    const soon = sum((l) => l.expiresOn === plusDays(today, 14));
    const burned = sum((l) => l.expiresOn === today);
    if (activated > 0 && (await sendOnce(id, subs, "activated", today, activatedMessage(activated, b.available)))) sent++;
    if (soon > 0 && (await sendOnce(id, subs, "expiring", plusDays(today, 14), expiringSoonMessage(soon, ru(plusDays(today, 14)))))) sent++;
    if (burned > 0 && (await sendOnce(id, subs, "expired", today, expiredMessage(burned, b.available)))) sent++;
  }
  return { clients: ids.length, sent };
}
