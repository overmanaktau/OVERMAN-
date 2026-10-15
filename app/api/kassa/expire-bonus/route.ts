import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { createBonusWriteOff } from "@/lib/moysklad";
import { syncOneClient } from "@/lib/kassa/clientSync";
import { todayAlmaty } from "@/lib/kassa/sync";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { escapeHtml } from "@/lib/telegram";

export const maxDuration = 300;

// Ночное сгорание бонусов (pg_cron после ночной загрузки клиентов): бонус хранится 4 месяца с момента начисления. Сам МойСклад бонусы не сжигает,
// поэтому клиентам, у которых после ночного пересчёта есть сгоревшие и ещё не списанные бонусы (kassa_clients.bonus_expired), создаётся
// операция списания «Сгорание бонусов» в программе «5% OVER». Повтор в тот же день безопасен (externalCode expire-<клиент>-<дата>).
// ?dry=1 — только показать, кому и сколько. Итог (если что-то сгорело или были ошибки) приходит владельцу в Telegram.
// Для проверок: ?client=<id клиента МойСклад> — обработать только его (с предварительным пересчётом), ?quiet=1 — без сообщения владельцу.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const dry = params.get("dry") === "1";
  const quiet = params.get("quiet") === "1";
  const onlyClient = params.get("client");
  const today = todayAlmaty();
  try {
    let candidates: { ms_id: string; name: string; phone: string; bonus_expired: number }[];
    if (onlyClient) {
      await syncOneClient(onlyClient);
      const { data: one } = await supabaseAdmin.from("kassa_clients").select("ms_id, name, phone, bonus_expired").eq("ms_id", onlyClient).maybeSingle();
      candidates = one ? [one as (typeof candidates)[number]] : [];
    } else {
      const { data, error } = await supabaseAdmin.from("kassa_clients").select("ms_id, name, phone, bonus_expired").gt("bonus_expired", 0).order("bonus_expired", { ascending: false });
      if (error) throw error;
      candidates = (data ?? []) as typeof candidates;
    }
    if (dry) {
      return NextResponse.json({ dry: true, today, clients: candidates.length, total: Math.round(candidates.reduce((a, c) => a + Number(c.bonus_expired), 0)), top: candidates.slice(0, 10) });
    }
    let done = 0;
    let total = 0;
    const errors: string[] = [];
    for (const c of candidates) {
      try {
        // свежий пересчёт клиента перед списанием: сумму берём из него, а не из ночной записи
        await syncOneClient(c.ms_id);
        const { data: fresh } = await supabaseAdmin.from("kassa_clients").select("bonus_expired").eq("ms_id", c.ms_id).maybeSingle();
        const value = Math.round(Number(fresh?.bonus_expired ?? 0));
        if (value <= 0) continue;
        const op = await createBonusWriteOff(c.ms_id, value, `expire-${c.ms_id}-${today}`, `Сгорание бонусов (срок 4 месяца), ${today}`);
        if (op.created) {
          const { error: logError } = await supabaseAdmin.from("kassa_bonus_expiry_log").insert({ run_date: today, client_ms_id: c.ms_id, client_name: c.name, phone: c.phone, value, tx_id: op.id });
          if (logError) throw logError;
          done++;
          total += value;
          await syncOneClient(c.ms_id); // после списания в списке портала сгоревших уже нет
        }
      } catch (e) {
        errors.push(`${c.name || c.phone}: ${getErrorMessage(e)}`);
      }
    }
    if (!quiet && (done > 0 || errors.length > 0)) {
      await notifyOwner(
        `🔥 <b>Сгорание бонусов · ${today.split("-").reverse().join(".")}</b>\n${done > 0 ? `Обнулено у ${done} клиентов: ${Math.round(total).toLocaleString("ru-RU")} бонусов (срок 4 месяца с начисления).` : "Списывать было нечего."}${errors.length > 0 ? `\n⚠️ Ошибок: ${errors.length}\n${errors.slice(0, 5).map(escapeHtml).join("\n")}` : ""}`
      );
    }
    return NextResponse.json({ ok: true, today, candidates: candidates.length, written: done, total: Math.round(total), errors: errors.slice(0, 20) });
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
