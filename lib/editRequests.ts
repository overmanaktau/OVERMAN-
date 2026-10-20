// Запросы на правку внесённых данных («Запросы» на сайте): решение (одобрить / отказать) и сообщение владельцу в Telegram
// о новом запросе с кнопками. Одна и та же логика работает и для кнопок на сайте (app/api/edit-requests/[id]/…), и для кнопок в Telegram.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { shortPerson } from "@/lib/personName";

export type Reviewer = { id: string | null; name: string };
export type Decision = { ok: true; summary: string } | { ok: false; status: number; error: string };

const TABLE_LABEL: Record<string, string> = {
  traffic_entries: "Трафик и каналы",
  extra_expenses: "Доп. расходы",
  sales_plan_monthly: "План продаж",
  sales_plan_periods: "Периоды плана продаж",
  fin_operations: "Финансы: операция ДДС",
  fin_debts: "Финансы: долг",
};
const STORE_LABEL: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };

type EditRequestRow = {
  id: number;
  table_name: string;
  row_id: number | null;
  store: string | null;
  context: string | null;
  requested_by: string | null;
  status: string;
  entry_date: string | null;
  created_at: string;
};

const ymdRu = (d: string) => d.split("-").reverse().join(".");

async function requesterName(userId: string | null): Promise<string> {
  if (!userId) return "сотрудник";
  const { data } = await supabaseAdmin.from("user_roles").select("full_name").eq("user_id", userId).maybeSingle();
  if (data?.full_name) return data.full_name as string;
  const { data: u } = await supabaseAdmin.auth.admin.getUserById(userId);
  return u?.user?.email ?? "сотрудник";
}

// Краткое описание запроса для сообщений: что, где, за какую дату.
export async function describeRequest(r: EditRequestRow): Promise<string> {
  const who = shortPerson(await requesterName(r.requested_by));
  const lines = [
    `Раздел: ${TABLE_LABEL[r.table_name] ?? r.table_name}`,
    `Кто просит: ${escapeHtml(who)}`,
  ];
  if (r.store) lines.push(`Город: ${STORE_LABEL[r.store] ?? escapeHtml(r.store)}`);
  if (r.entry_date) lines.push(`Дата строки: ${ymdRu(r.entry_date)}`);
  lines.push(r.row_id == null ? "Что нужно: первичное внесение за эту дату" : "Что нужно: изменить уже внесённую строку");
  if (r.context && r.context.trim()) lines.push(`Комментарий: ${escapeHtml(r.context.trim())}`);
  return lines.join("\n");
}

// Одобрить запрос: строка открывается на 30 минут для правки (при первичном внесении — создаётся пустая строка).
export async function approveEditRequest(id: number, reviewer: Reviewer): Promise<Decision> {
  const { data: req, error: fetchError } = await supabaseAdmin.from("edit_requests").select("*").eq("id", id).maybeSingle();
  if (fetchError) return { ok: false, status: 400, error: fetchError.message };
  if (!req) return { ok: false, status: 404, error: "Запрос не найден." };
  if (req.status !== "pending") return { ok: false, status: 400, error: "Запрос уже обработан." };

  const unlockExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  let targetRowId: number = req.row_id;

  if (targetRowId == null) {
    // Первичное внесение за дату вне свободного окна (вчера/сегодня) — строки ещё нет: создаём пустую, уже открытую
    // и ограниченную по времени, чтобы сотрудник её заполнил.
    if (!req.entry_date) return { ok: false, status: 400, error: "В заявке не указана дата строки." };
    // План продаж просят изменить только когда он уже внесён (строка есть).
    if (req.table_name === "sales_plan_monthly" || req.table_name === "sales_plan_periods") {
      return { ok: false, status: 400, error: "В заявке на план продаж не указана строка." };
    }
    const inserted =
      req.table_name === "traffic_entries"
        ? await supabaseAdmin
            .from("traffic_entries")
            .insert({ store: req.store, entry_date: req.entry_date, locked: false, unlock_expires_at: unlockExpiresAt })
            .select("id")
            .single()
        : await supabaseAdmin
            .from("extra_expenses")
            .insert({ expense_date: req.entry_date, category: "", amount: 0, comment: "", locked: false, unlock_expires_at: unlockExpiresAt })
            .select("id")
            .single();
    if (inserted.error) return { ok: false, status: 400, error: inserted.error.message };
    targetRowId = inserted.data.id;
  } else {
    const { error: unlockError } = await supabaseAdmin.from(req.table_name).update({ locked: false, unlock_expires_at: unlockExpiresAt }).eq("id", targetRowId);
    if (unlockError) return { ok: false, status: 400, error: unlockError.message };
  }

  const { error: statusError } = await supabaseAdmin
    .from("edit_requests")
    .update({ status: "approved", row_id: targetRowId, reviewed_at: new Date().toISOString(), reviewed_by: reviewer.id, reviewed_by_name: reviewer.name })
    .eq("id", req.id)
    .eq("status", "pending");
  if (statusError) return { ok: false, status: 400, error: statusError.message };
  return { ok: true, summary: await describeRequest(req as EditRequestRow) };
}

export async function denyEditRequest(id: number, reviewer: Reviewer): Promise<Decision> {
  const { data: req, error: fetchError } = await supabaseAdmin.from("edit_requests").select("*").eq("id", id).maybeSingle();
  if (fetchError) return { ok: false, status: 400, error: fetchError.message };
  if (!req) return { ok: false, status: 404, error: "Запрос не найден." };
  if (req.status !== "pending") return { ok: false, status: 400, error: "Запрос уже обработан." };
  const { error } = await supabaseAdmin
    .from("edit_requests")
    .update({ status: "denied", reviewed_at: new Date().toISOString(), reviewed_by: reviewer.id, reviewed_by_name: reviewer.name })
    .eq("id", req.id)
    .eq("status", "pending");
  if (error) return { ok: false, status: 400, error: error.message };
  return { ok: true, summary: await describeRequest(req as EditRequestRow) };
}

// Сообщение владельцу о новом запросе — с кнопками «Одобрить» и «Отклонить» (callback er:ap:<id> / er:dn:<id>).
export async function notifyNewEditRequest(id: number): Promise<boolean> {
  const { data: req, error } = await supabaseAdmin.from("edit_requests").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!req || req.status !== "pending") return false;
  const text = `📝 <b>Новый запрос №${req.id}</b>\n${await describeRequest(req as EditRequestRow)}`;
  await notifyOwner(text, {
    inline_keyboard: [[{ text: "✅ Одобрить", callback_data: `er:ap:${req.id}` }, { text: "❌ Отклонить", callback_data: `er:dn:${req.id}` }]],
  });
  return true;
}

// Решение владельца кнопкой в Telegram.
export async function handleEditRequestCallback(data: string, ownerName: string): Promise<string> {
  const [, action, idRaw] = data.split(":");
  const id = Number(idRaw);
  if (!Number.isInteger(id) || (action !== "ap" && action !== "dn")) return "Неверная кнопка.";
  const { data: owner } = await supabaseAdmin.from("user_roles").select("user_id").eq("role", "owner").limit(1).maybeSingle();
  const reviewer: Reviewer = { id: (owner?.user_id as string | undefined) ?? null, name: `${shortPerson(ownerName)} (Telegram)` };
  const res = action === "ap" ? await approveEditRequest(id, reviewer) : await denyEditRequest(id, reviewer);
  if (!res.ok) return `⚠️ Запрос №${id}: ${escapeHtml(res.error)}`;
  return action === "ap"
    ? `✅ <b>Запрос №${id} одобрен</b> — строка открыта для правки на 30 минут.\n${res.summary}`
    : `❌ <b>Запрос №${id} отклонён.</b>\n${res.summary}`;
}
