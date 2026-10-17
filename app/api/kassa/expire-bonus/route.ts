import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { createBonusWriteOff } from "@/lib/moysklad";
import { syncOneClient } from "@/lib/kassa/clientSync";
import { todayAlmaty } from "@/lib/kassa/sync";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { sendExpiryRequest, type ExpiryRequest } from "@/lib/kassa/expiryRequests";
import { escapeHtml } from "@/lib/telegram";

export const maxDuration = 300;

// Сгорание бонусов: бонус хранится 4 месяца с момента начисления. Сам МойСклад бонусы не сжигает, поэтому клиентам со сгоревшими и ещё не
// списанными бонусами (kassa_clients.bonus_expired) создаётся операция списания «Сгорание бонусов» в программе «5% OVER».
// ТОЛЬКО С РАЗРЕШЕНИЯ ВЛАДЕЛЬЦА (с 17.10.2026):
//  · без параметров (pg_cron ночью, 03:35) — собирает запрос «к сгоранию N клиентов, X бонусов» и присылает владельцу в бот-помощник
//    с кнопками «Разрешить» / «Отклонить» / «Список»; сама ничего не списывает;
//  · ?run=1 (pg_cron каждые 5 минут) — если владелец разрешил, списывает порциями (до ~230 с за запуск) и в конце шлёт итог;
//  · ?dry=1 — только показать, кому и сколько.
// Повтор безопасен: у каждой операции externalCode expire-<клиент>-<дата запроса>, перед списанием клиент пересчитывается заново.
type Cand = { ms_id: string; name: string; phone: string; bonus_expired: number };
const BUDGET_MS = 230_000;
const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");

async function loadCandidates(): Promise<Cand[]> {
  const { data, error } = await supabaseAdmin.from("kassa_clients").select("ms_id, name, phone, bonus_expired").gt("bonus_expired", 0).order("bonus_expired", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Cand[];
}

// Ночной запрос владельцу.
async function propose(dry: boolean) {
  const today = todayAlmaty();
  const candidates = await loadCandidates();
  const total = candidates.reduce((a, c) => a + Number(c.bonus_expired), 0);
  if (dry) return { dry: true, today, clients: candidates.length, total: Math.round(total), top: candidates.slice(0, 10) };
  if (candidates.length === 0) return { ok: true, today, clients: 0 };

  const { data: running } = await supabaseAdmin.from("kassa_bonus_expiry_requests").select("id").eq("status", "approved").limit(1);
  if (running && running.length > 0) return { ok: true, today, skipped: "идёт списание по разрешённому запросу" };

  const row = { run_date: today, clients: candidates.length, total, pending_ids: candidates.map((c) => c.ms_id), error_ids: [], written: 0, written_total: 0 };
  const { data: existing } = await supabaseAdmin.from("kassa_bonus_expiry_requests").select("*").eq("status", "pending").order("id", { ascending: false }).limit(1);
  let req: ExpiryRequest;
  const reminder = !!existing && existing.length > 0;
  if (reminder) {
    // владелец ещё не ответил — обновляем тот же запрос свежими цифрами и напоминаем
    const { data, error } = await supabaseAdmin.from("kassa_bonus_expiry_requests").update(row).eq("id", existing![0].id).select("*").single();
    if (error) throw error;
    req = data as ExpiryRequest;
  } else {
    const { data, error } = await supabaseAdmin.from("kassa_bonus_expiry_requests").insert(row).select("*").single();
    if (error) throw error;
    req = data as ExpiryRequest;
  }
  await sendExpiryRequest(req, candidates, reminder);
  return { ok: true, today, request: req.id, clients: req.clients, total: Math.round(total), reminder };
}

// Списание по разрешённому запросу — порциями.
async function runApproved() {
  const { data: reqs, error } = await supabaseAdmin.from("kassa_bonus_expiry_requests").select("*").eq("status", "approved").order("id").limit(1);
  if (error) throw error;
  if (!reqs || reqs.length === 0) return { ok: true, idle: true };
  const req = reqs[0] as ExpiryRequest;
  const queue = [...req.pending_ids];
  const errorIds = new Set(req.error_ids);
  const errors: string[] = [];
  const startedAt = Date.now();
  let written = 0;
  let writtenTotal = 0;
  let next = 0;
  const finished: string[] = []; // обработаны (списаны, ничего не осталось или ошибка) — в очередь не возвращаются

  const processOne = async (id: string) => {
    try {
      // свежий пересчёт клиента перед списанием: сумму берём из него, а не из запроса
      await syncOneClient(id);
      const { data: fresh } = await supabaseAdmin.from("kassa_clients").select("name, phone, bonus_expired").eq("ms_id", id).maybeSingle();
      const value = Math.round(Number(fresh?.bonus_expired ?? 0));
      if (value > 0) {
        const op = await createBonusWriteOff(id, value, `expire-${id}-${req.run_date}`, `Сгорание бонусов (срок 4 месяца), ${req.run_date}`);
        if (op.created) {
          written++;
          writtenTotal += value;
          const { error: logError } = await supabaseAdmin.from("kassa_bonus_expiry_log").insert({ run_date: req.run_date, client_ms_id: id, client_name: fresh?.name ?? "", phone: fresh?.phone ?? "", value, tx_id: op.id, request_id: req.id });
          if (logError) throw logError;
          await syncOneClient(id); // после списания в списке портала сгоревших уже нет
        }
      }
      finished.push(id);
    } catch (e) {
      errorIds.add(id);
      errors.push(`${id}: ${getErrorMessage(e)}`);
      finished.push(id); // ошибку не повторяем бесконечно — попадёт в итог
    }
  };
  const worker = async () => {
    while (next < queue.length && Date.now() - startedAt < BUDGET_MS) await processOne(queue[next++]);
  };
  await Promise.all([worker(), worker(), worker()]);

  const done = new Set(finished);
  const remaining = queue.filter((id) => !done.has(id));
  const isDone = remaining.length === 0;
  const patch = {
    pending_ids: remaining,
    error_ids: [...errorIds],
    written: req.written + written,
    written_total: Number(req.written_total) + writtenTotal,
    ...(isDone ? { status: "done", finished_at: new Date().toISOString() } : {}),
  };
  const { error: upError } = await supabaseAdmin.from("kassa_bonus_expiry_requests").update(patch).eq("id", req.id);
  if (upError) throw upError;
  if (isDone) {
    await notifyOwner(
      `🔥 <b>Сгорание бонусов выполнено</b> (запрос от ${req.run_date.split("-").reverse().join(".")})\nОбнулено у ${patch.written} клиентов: ${fmt(patch.written_total)} бонусов.${errorIds.size > 0 ? `\n⚠️ Ошибок: ${errorIds.size} клиентов — они в этот раз не списаны, придут в следующем запросе.\n${errors.slice(0, 3).map(escapeHtml).join("\n")}` : ""}`
    );
  }
  return { ok: true, request: req.id, written, writtenTotal, remaining: remaining.length, done: isDone, errors: errors.slice(0, 10) };
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  try {
    if (params.get("run") === "1") return NextResponse.json(await runApproved());
    return NextResponse.json(await propose(params.get("dry") === "1"));
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
