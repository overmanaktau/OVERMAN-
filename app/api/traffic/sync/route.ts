import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { fetchDailyTraffic } from "@/lib/trafficCounters";
import { yesterdayInAlmaty } from "@/lib/reports/sales";

export const maxDuration = 60;

// Автоматическое внесение «Трафик факт» из счётчиков посетителей: за последние
// завершённые сутки (по умолчанию 3, чтобы пропущенный запуск догнался)
// пишет в traffic_entries.traffic_fact «вошло» с вычетом процента точки
// (Актау −5%, Актобе по факту — см. lib/trafficCounters.ts).
// Уже внесённый факт (вручную или раньше) не перезаписывается — только
// пустой. Сутки, по которым счётчик ещё не передал данные до конца дня,
// пропускаются. Расписание — pg_cron (CRON_SECRET) или админ вручную.
// ?days=N — сколько суток назад смотреть (1–20); ?dry=1 — только показать.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 3, 1), 20);
  const dry = url.searchParams.get("dry") === "1";

  try {
    const today = new Date(`${yesterdayInAlmaty()}T00:00:00Z`);
    today.setUTCDate(today.getUTCDate() + 1);
    const todayYmd = today.toISOString().slice(0, 10);

    const rows = await fetchDailyTraffic(days, todayYmd);
    const results: { store: string; date: string; income: number; fact: number; action: string }[] = [];

    for (const r of rows) {
      const base = { store: r.store, date: r.date, income: r.income, fact: r.fact };
      if (!r.complete) {
        results.push({ ...base, action: "пропущено: счётчик ещё не передал данные за весь день" });
        continue;
      }
      const { data: existing, error: selectError } = await supabaseAdmin
        .from("traffic_entries")
        .select("id, traffic_fact")
        .eq("store", r.store)
        .eq("entry_date", r.date)
        .maybeSingle();
      if (selectError) throw selectError;

      if (existing && existing.traffic_fact !== null) {
        results.push({ ...base, action: `пропущено: факт уже внесён (${existing.traffic_fact})` });
        continue;
      }
      if (dry) {
        results.push({ ...base, action: existing ? "обновил бы пустой факт" : "создал бы строку" });
        continue;
      }
      const { error: writeError } = existing
        ? await supabaseAdmin.from("traffic_entries").update({ traffic_fact: r.fact }).eq("id", existing.id)
        : await supabaseAdmin.from("traffic_entries").insert({ store: r.store, entry_date: r.date, traffic_fact: r.fact });
      if (writeError) throw writeError;
      results.push({ ...base, action: existing ? "обновлён пустой факт" : "создана строка" });
    }

    return NextResponse.json({ ok: true, dry, days, results });
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
