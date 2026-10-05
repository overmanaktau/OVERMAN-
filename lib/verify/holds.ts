// Удержание отчётов: если расхождение исправить не удалось, неправильный отчёт в группы
// не уходит, пока его не исправят (миграция 071). Удержание — по городу и по дню: отчёт
// города ждёт, если в его период входит день с неисправленным расхождением этого города
// (или общим, store = 'all', — например, не отработала синхронизация).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";

export type ReportKind = "day" | "week" | "month";

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Какие дни попадают в отчёт: дневной — этот день, недельный — 7 дней, заканчивая датой,
// месячный — с 1-го числа месяца этой даты по неё.
export function reportRange(kind: ReportKind, date: string): { from: string; to: string } {
  if (kind === "day") return { from: date, to: date };
  if (kind === "week") return { from: addDays(date, -6), to: date };
  return { from: `${date.slice(0, 8)}01`, to: date };
}

export function reportKindOf(period: string | null): ReportKind {
  return period === "week" ? "week" : period === "month" ? "month" : "day";
}

// Неисправленное расхождение, из-за которого отчёт города ждёт (первое найденное), либо null.
export async function activeHoldFor(cityCodes: string[], range: { from: string; to: string }) {
  const { data, error } = await supabaseAdmin
    .from("report_holds")
    .select("check_date, store, reason")
    .eq("status", "held")
    .gte("check_date", range.from)
    .lte("check_date", range.to)
    .in("store", [...cityCodes, "all"])
    .order("check_date")
    .limit(1);
  if (error) throw error;
  return (data?.[0] as { check_date: string; store: string; reason: string | null } | undefined) ?? null;
}

export async function setHold(date: string, store: string, reason: string) {
  const { error } = await supabaseAdmin
    .from("report_holds")
    .upsert({ check_date: date, store, status: "held", reason, created_at: new Date().toISOString(), released_at: null, released_by: null }, { onConflict: "check_date,store" });
  if (error) throw error;
}

// Снимает удержание за день: со всех городов или только с тех, что не в списке `keep`.
export async function releaseHolds(date: string, by: string, keep: string[] = []) {
  let query = supabaseAdmin
    .from("report_holds")
    .update({ status: "released", released_at: new Date().toISOString(), released_by: by })
    .eq("check_date", date)
    .eq("status", "held");
  if (keep.length > 0) query = query.not("store", "in", `(${keep.join(",")})`);
  const { error } = await query;
  if (error) throw error;
}

export async function heldDates(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("report_holds").select("check_date").eq("status", "held");
  if (error) throw error;
  return [...new Set((data ?? []).map((r) => r.check_date as string))].sort();
}

// Запоминает, что отчёт не ушёл. true — запись новая (владельцу об этом ещё не говорили).
export async function recordHeldReport(kind: ReportKind, date: string, store: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("held_reports")
    .upsert({ kind, report_date: date, store }, { onConflict: "kind,report_date,store", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// Отправляет отчёты, которые ждали и больше не заблокированы. Возвращает, что ушло.
export async function sendReleasedReports(origin: string, secret: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("held_reports")
    .select("id, kind, report_date, store")
    .is("sent_at", null)
    .order("report_date");
  if (error) throw error;
  const sent: string[] = [];
  const label: Record<ReportKind, string> = { day: "дневной", week: "недельный", month: "месячный" };
  for (const r of (data ?? []) as { id: number; kind: ReportKind; report_date: string; store: string }[]) {
    const hold = await activeHoldFor([r.store], reportRange(r.kind, r.report_date));
    if (hold) continue; // всё ещё ждёт другого исправления
    const period = r.kind === "day" ? "" : `&period=${r.kind}`;
    try {
      const res = await fetch(`${origin}/api/telegram/report?date=${r.report_date}${period}&scope=${r.store}&force=1`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        sent.push(`${label[r.kind]} за ${r.report_date} (${r.store}): не отправился (ошибка ${res.status})`);
        continue;
      }
      await supabaseAdmin.from("held_reports").update({ sent_at: new Date().toISOString() }).eq("id", r.id);
      sent.push(`${label[r.kind]} за ${r.report_date} (${r.store}): отправлен`);
    } catch (e) {
      sent.push(`${label[r.kind]} за ${r.report_date} (${r.store}): не отправился (${getErrorMessage(e)})`);
    }
  }
  return sent;
}
