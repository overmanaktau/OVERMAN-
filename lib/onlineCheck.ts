// Онлайн-чеки Актау: «онлайн» в комментарии — онлайн сразу; «похоже на онлайн» — Нуржану уходит вопрос с кнопками ✅ Да / ❌ Нет (решение владельца 09.11.2026).
// Ответы хранятся в журнале бота coach_messages_sent: вид «onl_y:<id чека>» / «onl_n:<id чека>», «onl_q:<id чека>» — вопрос уже задан (одна запись на чек).
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
  for (let i = 0; i < ids.length; i += 60) {
    const part = ids.slice(i, i + 60);
    const kinds = part.flatMap((id) => [`onl_y:${id}`, `onl_n:${id}`]);
    const { data, error } = await supabaseAdmin.from("coach_messages_sent").select("kind, sent_at").in("kind", kinds).order("sent_at", { ascending: true });
    if (error) throw error;
    for (const r of (data ?? []) as { kind: string }[]) out.set(r.kind.slice(6), r.kind.startsWith("onl_y:")); // позже записанный ответ перекрывает прежний
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

// Записать ответ на вопрос «Это онлайн?» (кнопка у Нуржана или владельца).
export async function saveOnlineAnswer(demandId: string, online: boolean, userId: number): Promise<void> {
  const { data: q, error } = await supabaseAdmin.from("coach_messages_sent").select("ref_date").eq("kind", `onl_q:${demandId}`).limit(1).maybeSingle();
  if (error) throw error;
  const refDate = (q as { ref_date?: string } | null)?.ref_date ?? new Date().toISOString().slice(0, 10);
  const { error: delErr } = await supabaseAdmin.from("coach_messages_sent").delete().in("kind", [`onl_y:${demandId}`, `onl_n:${demandId}`]);
  if (delErr) throw delErr;
  const { error: insErr } = await supabaseAdmin.from("coach_messages_sent").insert({ user_id: userId, kind: `${online ? "onl_y" : "onl_n"}:${demandId}`, ref_date: refDate });
  if (insErr) throw insErr;
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
  const answered = await loadOnlineAnswers(ids);
  const { data: asked, error: askErr } = await supabaseAdmin.from("coach_messages_sent").select("kind").in("kind", ids.map((id) => `onl_q:${id}`));
  if (askErr) throw askErr;
  const askedSet = new Set(((asked ?? []) as { kind: string }[]).map((r) => r.kind.slice(6)));

  const todo = demands.filter((d) => !answered.has(d.id as string) && !askedSet.has(d.id as string));
  const checks = todo.map((d) => ({ number: d.name ?? "—", comment: (d.description ?? "").trim() }));
  if (dry) return { asked: 0, checks };
  for (const d of todo) {
    const id = d.id as string;
    const text =
      `❓ <b>Это онлайн-продажа?</b>\n` +
      `Чек ${escapeHtml(d.name ?? "—")} · ${dm(date)} · ${escapeHtml(d.owner?.name ?? "—")} · ${trim2Ru((d.sum ?? 0) / 100)} ₸\n` +
      `Комментарий: «${escapeHtml((d.description ?? "").trim())}»`;
    await telegramTransport.send(user.telegram_chat_id, text, { inline_keyboard: [[{ text: "✅ Да", callback_data: `ol:y:${id}` }, { text: "❌ Нет", callback_data: `ol:n:${id}` }]] });
    const { error: markErr } = await supabaseAdmin.from("coach_messages_sent").insert({ user_id: user.id, kind: `onl_q:${id}`, ref_date: date });
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
