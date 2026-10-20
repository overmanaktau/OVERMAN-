// Кнопка «Повторить сейчас» под сообщением о сбое сгорания бонусов (само списание — в маршруте /api/kassa/expire-bonus, оно автоматическое).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { shortPerson } from "@/lib/personName";

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
  decided_by?: string | null;
};

// Нажатие be:retry:<id> в боте-помощнике (только главный владелец): заново пробуем тех клиентов, по кому списание не вышло.
export async function handleExpiryCallback(data: string, ownerName: string): Promise<{ text: string }> {
  const [, action, idRaw] = data.split(":");
  const id = Number(idRaw);
  if (action !== "retry" || !Number.isInteger(id)) return { text: "Неверная кнопка." };
  const { data: row } = await supabaseAdmin.from("kassa_bonus_expiry_requests").select("*").eq("id", id).maybeSingle();
  const req = row as ExpiryRequest | null;
  if (!req) return { text: "Запрос не найден." };
  if (req.status === "approved") return { text: "Списание по этому запросу уже идёт — подождите несколько минут." };
  const failed = req.error_ids.map((x) => String(x).split("|")[0]).filter(Boolean);
  if (failed.length === 0) return { text: "По этому запросу нечего повторять: ошибок нет." };
  await supabaseAdmin
    .from("kassa_bonus_expiry_requests")
    .update({ status: "approved", pending_ids: failed, error_ids: [], finished_at: null, decided_at: new Date().toISOString(), decided_by: `${shortPerson(ownerName)} (повтор)` })
    .eq("id", id);
  return { text: `🔄 Повторяю списание по ${failed.length} клиентам, у которых не вышло. Итог пришлю только если снова не получится.` };
}
