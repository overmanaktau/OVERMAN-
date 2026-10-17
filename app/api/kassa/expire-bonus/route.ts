import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { createBonusWriteOff } from "@/lib/moysklad";
import { syncOneClient } from "@/lib/kassa/clientSync";
import { todayAlmaty } from "@/lib/kassa/sync";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { type ExpiryRequest } from "@/lib/kassa/expiryRequests";
import { escapeHtml } from "@/lib/telegram";

export const maxDuration = 300;

// Сгорание бонусов: бонус хранится 4 месяца с момента начисления. Сам МойСклад бонусы не сжигает, поэтому клиентам со сгоревшими и ещё не
// списанными бонусами (kassa_clients.bonus_expired) создаётся операция списания «Сгорание бонусов» в программе «5% OVER».
// АВТОМАТИЧЕСКИ, БЕЗ РАЗРЕШЕНИЯ (решение владельца 17.10.2026); в Telegram владельцу приходит только то, что НЕ удалось списать:
//  · без параметров (pg_cron ночью, 03:35) — собирает запрос «к сгоранию N клиентов» (статус «разрешён» сразу, decided_by = автоматически);
//  · ?run=1 (pg_cron каждые 5 минут) — списывает порциями (до ~230 с за запуск); ошибки по клиентам и сбои запуска → сообщение владельцу;
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
  if (running && running.length > 0) return { ok: true, today, skipped: "идёт списание по предыдущему запросу" };

  const row = {
    run_date: today,
    status: "approved",
    clients: candidates.length,
    total,
    pending_ids: candidates.map((c) => c.ms_id),
    error_ids: [],
    written: 0,
    written_total: 0,
    decided_at: new Date().toISOString(),
    decided_by: "автоматически",
  };
  // если от прошлых ночей остался неразрешённый запрос — обновляем его тем же способом, иначе создаём новый
  const { data: stale } = await supabaseAdmin.from("kassa_bonus_expiry_requests").select("id").eq("status", "pending").order("id", { ascending: false }).limit(1);
  if (stale && stale.length > 0) {
    const { error } = await supabaseAdmin.from("kassa_bonus_expiry_requests").update(row).eq("id", stale[0].id);
    if (error) throw error;
    return { ok: true, today, request: stale[0].id, clients: row.clients, total: Math.round(total), auto: true };
  }
  const { data, error } = await supabaseAdmin.from("kassa_bonus_expiry_requests").insert(row).select("id").single();
  if (error) throw error;
  return { ok: true, today, request: (data as { id: number }).id, clients: row.clients, total: Math.round(total), auto: true };
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
      // в error_ids храним «id|причина», чтобы в итоговом сообщении была причина и по прошлым порциям
      errorIds.add(`${id}|${getErrorMessage(e).slice(0, 200)}`);
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
  // владельцу — только если что-то не удалось списать (успешный итог не присылаем)
  if (isDone && errorIds.size > 0) {
    await notifyOwner(
      `⚠️ <b>Сгорание бонусов: не удалось списать у ${errorIds.size} клиентов</b> (запрос от ${req.run_date.split("-").reverse().join(".")}).\nОстальным списано: ${patch.written} клиентов, ${fmt(patch.written_total)} бонусов.\nНе списанные попробуем снова следующей ночью.\n${[...errorIds].slice(0, 3).map((x) => escapeHtml(x.replace("|", ": "))).join("\n")}`
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
    const message = getErrorMessage(e);
    // сбой всего запуска (например, МойСклад не отвечает) — сообщаем владельцу, но не чаще раза в 3 часа, чтобы не слать каждые 5 минут
    try {
      const { data: last } = await supabaseAdmin.from("kassa_bonus_expiry_requests").select("id, error_notified_at").eq("status", "approved").order("id", { ascending: false }).limit(1);
      const row = (last ?? [])[0] as { id: number; error_notified_at: string | null } | undefined;
      const recent = row?.error_notified_at && Date.now() - new Date(row.error_notified_at).getTime() < 3 * 3600000;
      if (!recent) {
        await notifyOwner(`⚠️ <b>Сгорание бонусов: сбой запуска</b>\n${escapeHtml(message)}\nБонусы не списаны, повторю автоматически.`);
        if (row) await supabaseAdmin.from("kassa_bonus_expiry_requests").update({ error_notified_at: new Date().toISOString() }).eq("id", row.id);
      }
    } catch {
      // сообщение о сбое не должно маскировать сам сбой
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
