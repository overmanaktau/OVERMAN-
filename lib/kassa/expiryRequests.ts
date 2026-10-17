// Кнопки старого режима «с разрешением» (сообщения с кнопками уже могли остаться в чате владельца) — решение и список. С 17.10.2026 сгорание автоматическое,
// само списание — в маршруте /api/kassa/expire-bonus.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import type { ReplyMarkup } from "@/lib/coach/bot";

export type ExpiryRequest = {
  id: number;
  run_date: string;
  status: "pending" | "approved" | "rejected" | "done";
  clients: number;
  total: number;
  pending_ids: string[];
  error_ids: string[];
  written: number;
  written_total: number;
};

const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");
const ru = (d: string) => d.split("-").reverse().join(".");

type Cand = { ms_id: string; name: string; phone: string; bonus_expired: number };

export function requestMarkup(id: number): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "✅ Разрешить", callback_data: `be:ok:${id}` }, { text: "❌ Отклонить", callback_data: `be:no:${id}` }],
      [{ text: "📋 Список клиентов", callback_data: `be:list:${id}` }],
    ],
  };
}

const line = (c: Cand) => `${escapeHtml(c.name || "без имени")}${c.phone ? ` · ${escapeHtml(c.phone)}` : ""} — ${fmt(Number(c.bonus_expired))}`;

async function load(id: number): Promise<ExpiryRequest | null> {
  const { data } = await supabaseAdmin.from("kassa_bonus_expiry_requests").select("*").eq("id", id).maybeSingle();
  return (data as ExpiryRequest | null) ?? null;
}

// Нажатия be:<действие>:<id> в боте-помощнике (только главный владелец).
export async function handleExpiryCallback(data: string, ownerName: string): Promise<{ text: string; markup?: ReplyMarkup }> {
  const [, action, idRaw] = data.split(":");
  const id = Number(idRaw);
  const req = Number.isInteger(id) ? await load(id) : null;
  if (!req) return { text: "Запрос не найден." };

  if (action === "list") {
    const ids = req.status === "pending" || req.status === "approved" ? req.pending_ids : [];
    if (ids.length === 0) return { text: "По этому запросу список уже пуст.", markup: undefined };
    const { data: rows } = await supabaseAdmin.from("kassa_clients").select("ms_id, name, phone, bonus_expired").in("ms_id", ids.slice(0, 600)).order("bonus_expired", { ascending: false }).limit(40);
    const list = ((rows ?? []) as Cand[]).filter((c) => Number(c.bonus_expired) > 0);
    return { text: `📋 <b>Крупнейшие к сгоранию</b> (40 из ${req.clients})\n${list.map((c, i) => `${i + 1}. ${line(c)}`).join("\n")}`, markup: req.status === "pending" ? requestMarkup(req.id) : undefined };
  }

  if (req.status !== "pending") {
    const done = req.status === "approved" ? "Уже разрешено, списание идёт." : req.status === "rejected" ? "Уже отклонено." : "Уже выполнено.";
    return { text: `${done} (запрос от ${ru(req.run_date)})` };
  }
  if (action === "ok") {
    await supabaseAdmin.from("kassa_bonus_expiry_requests").update({ status: "approved", decided_at: new Date().toISOString(), decided_by: ownerName }).eq("id", id);
    return { text: `✅ Разрешено: ${req.clients} клиентов, ${fmt(Number(req.total))} бонусов. Списание идёт порциями (задание запускается каждые 5 минут), по окончании пришлю итог.` };
  }
  if (action === "no") {
    await supabaseAdmin.from("kassa_bonus_expiry_requests").update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: ownerName }).eq("id", id);
    return { text: `❌ Отклонено. Бонусы не списаны. Завтра ночью придёт новый запрос с актуальной суммой.` };
  }
  return { text: "Неверная кнопка." };
}
