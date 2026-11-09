// Онлайн-чеки Актау: «онлайн» в комментарии — онлайн сразу; «похоже на онлайн» — Нуржану уходит вопрос с кнопками ✅ Да / ❌ Нет (решение владельца 09.11.2026).
// Ответы хранятся в таблице online_check_answers (миграция 121): одна строка на чек МойСклад — вопрос задан, ответ да/нет/ещё нет.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchRetailDemandsForDate, type RetailDemand } from "@/lib/moysklad";
import { REGISTER_STORE, registerCounts } from "@/lib/registers";
import { onlineVerdict } from "@/lib/onlineSales";
import { escapeHtml } from "@/lib/telegram";
import { telegramTransport } from "@/lib/coach/bot";
import { trim2Ru } from "@/lib/numFormat";

const NURZHAN_MS_ID = "755c7139-b6de-11f0-0a80-15b80002bbcb"; // Картбаев Нуржан, администратор Актау

// Ответы по чекам: true — онлайн, false — нет. Чеков без ответа в карте нет.
export async function loadOnlineAnswers(ids: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin.from("online_check_answers").select("demand_id, online").in("demand_id", ids.slice(i, i + 100)).not("online", "is", null);
    if (error) throw error;
    for (const r of (data ?? []) as { demand_id: string; online: boolean }[]) out.set(r.demand_id, r.online);
  }
  return out;
}

// Какие из чеков считаются онлайн: «онлайн» в комментарии — да; «похоже» — только если Нуржан ответил «Да». Без ответа такой чек пока не онлайн.
export async function onlineOnly(demands: RetailDemand[]): Promise<RetailDemand[]> {
  const maybe = demands.filter((d) => d.id && onlineVerdict(d.description) === "maybe");
  const answers = maybe.length > 0 ? await loadOnlineAnswers(maybe.map((d) => d.id as string)) : new Map<string, boolean>();
  return demands.filter((d) => {
    const v = onlineVerdict(d.description);
    return v === "yes" || (v === "maybe" && !!d.id && answers.get(d.id) === true);
  });
}

// Записать ответ на вопрос «Это онлайн?» (кнопка у Нуржана или владельца). Если вопроса в таблице нет (например, чек выбран вручную), строка создаётся.
export async function saveOnlineAnswer(demandId: string, online: boolean, userId: number): Promise<void> {
  const { data: row, error } = await supabaseAdmin.from("online_check_answers").select("demand_id").eq("demand_id", demandId).maybeSingle();
  if (error) throw error;
  const answer = { online, answered_by: userId, answered_at: new Date().toISOString() };
  const { error: wErr } = row
    ? await supabaseAdmin.from("online_check_answers").update(answer).eq("demand_id", demandId)
    : await supabaseAdmin.from("online_check_answers").insert({ demand_id: demandId, ref_date: new Date().toISOString().slice(0, 10), ...answer });
  if (wErr) throw wErr;
}

const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

// Вопросы Нуржану по чекам Актау за день, где комментарий похож на «онлайн», но не уверенно. Каждый чек — один раз.
export async function askOnlineQuestions(date: string, dry = false): Promise<{ asked: number; checks: { number: string; comment: string }[]; reason?: string }> {
  const demands = (await fetchRetailDemandsForDate(date)).filter((d) => {
    const id = d.retailStore?.id;
    return !!id && REGISTER_STORE[id] === "point_1" && registerCounts(id, date) && !!d.id && onlineVerdict(d.description) === "maybe";
  });
  if (demands.length === 0) return { asked: 0, checks: [] };
  const { data: user, error } = await supabaseAdmin.from("coach_users").select("id, telegram_chat_id").eq("employee_ms_id", NURZHAN_MS_ID).eq("status", "approved").maybeSingle();
  if (error) throw error;
  if (!user) return { asked: 0, checks: [], reason: "Нуржан не подключён к боту-помощнику" };

  const ids = demands.map((d) => d.id as string);
  const { data: asked, error: askErr } = await supabaseAdmin.from("online_check_answers").select("demand_id").in("demand_id", ids);
  if (askErr) throw askErr;
  const askedSet = new Set(((asked ?? []) as { demand_id: string }[]).map((r) => r.demand_id));
  // чек, по которому вопрос уже задан (с ответом или без), второй раз не спрашиваем
  const todo = demands.filter((d) => !askedSet.has(d.id as string));
  const checks = todo.map((d) => ({ number: d.name ?? "—", comment: (d.description ?? "").trim() }));
  if (dry) return { asked: 0, checks };
  for (const d of todo) {
    const id = d.id as string;
    const text =
      `❓ <b>Это онлайн-продажа?</b>\n` +
      `Чек ${escapeHtml(d.name ?? "—")} · ${dm(date)} · ${escapeHtml(d.owner?.name ?? "—")} · ${trim2Ru((d.sum ?? 0) / 100)} ₸\n` +
      `Комментарий: «${escapeHtml((d.description ?? "").trim())}»`;
    await telegramTransport.send(user.telegram_chat_id, text, { inline_keyboard: [[{ text: "✅ Да", callback_data: `ol:y:${id}` }, { text: "❌ Нет", callback_data: `ol:n:${id}` }]] });
    const { error: markErr } = await supabaseAdmin.from("online_check_answers").insert({ demand_id: id, ref_date: date });
    if (markErr) throw markErr;
  }
  return { asked: todo.length, checks };
}

// Нажатие кнопки «Да/Нет» под вопросом (callback_data «ol:y:<id>» / «ol:n:<id>»). Возвращает текст-подтверждение.
export async function handleOnlineCallback(data: string, userId: number): Promise<string> {
  const m = /^ol:([yn]):([0-9a-f-]{36})$/.exec(data);
  if (!m) return "Не понял ответ.";
  await saveOnlineAnswer(m[2], m[1] === "y", userId);
  return m[1] === "y" ? "Записал: это онлайн ✅" : "Записал: это не онлайн ❌";
}
