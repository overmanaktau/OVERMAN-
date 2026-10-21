import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { fetchRetailDemandsForDate } from "@/lib/moysklad";
import { accrualAmount, accrualStart, creditDueAccruals } from "@/lib/kassa/accrual";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { escapeHtml } from "@/lib/telegram";

export const maxDuration = 300;

// Начисление бонусов силами портала (lib/kassa/accrual.ts):
//  · без параметров (pg_cron ночью и днём) — зачисляет в МойСклад бонусы, у которых пришёл срок активации (покупка + 14 дней), и поправляет зачисленное, если чек изменили;
//    сбои и недоделанное владельцу — сообщением в Telegram;
//  · ?dry=1&date=ГГГГ-ММ-ДД — пробный прогон за один день: ничего не пишет, сравнивает «5% от суммы чека, вниз» с тем, что за этот день реально начислил МойСклад.
async function dryRun(date: string) {
  type Raw = { id: string; name?: string; sum?: number; agent?: { meta?: { href?: string } } };
  const demands = (await fetchRetailDemandsForDate(date)) as unknown as Raw[];
  const agentOf = (d: Raw) => d.agent?.meta?.href?.split("/").pop() ?? "";
  const ids = [...new Set(demands.map((d) => agentOf(d)).filter(Boolean))];
  const { data: clients } = await supabaseAdmin.from("kassa_clients").select("ms_id").in("ms_id", ids.slice(0, 1000));
  const clientSet = new Set((clients ?? []).map((c) => c.ms_id as string));
  const { data: tx } = await supabaseAdmin.from("kassa_bonus_tx").select("parent_id, value").eq("kind", "earn").eq("status", "COMPLETED").eq("parent_type", "retaildemand").in("parent_id", demands.map((d) => d.id));
  const actual = new Map<string, number>();
  for (const t of (tx ?? []) as { parent_id: string; value: number }[]) actual.set(t.parent_id, (actual.get(t.parent_id) ?? 0) + Number(t.value));
  let compared = 0;
  let matches = 0;
  let expectedTotal = 0;
  let actualTotal = 0;
  const mismatches: { name: string; sum: number; expected: number; actual: number }[] = [];
  for (const d of demands) {
    if (!clientSet.has(agentOf(d))) continue; // вне программы (нет тега или телефона)
    const sum = (d.sum ?? 0) / 100;
    const expected = accrualAmount(sum);
    const got = actual.get(d.id) ?? 0;
    compared++;
    expectedTotal += expected;
    actualTotal += got;
    if (expected === got) matches++;
    else mismatches.push({ name: d.name ?? d.id, sum, expected, actual: got });
  }
  return { date, checksTotal: demands.length, comparedClientChecks: compared, matches, mismatches: mismatches.length, expectedTotal, actualTotal, sample: mismatches.slice(0, 10) };
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  try {
    if (params.get("dry") === "1") {
      const date = params.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Нужна дата ГГГГ-ММ-ДД." }, { status: 400 });
      return NextResponse.json({ ok: true, dry: true, ...(await dryRun(date)) });
    }
    if (!(await accrualStart())) return NextResponse.json({ ok: true, idle: "начисление силами портала не включено" });
    const res = await creditDueAccruals();
    if (res.errors.length > 0 || res.remaining > 0) {
      await notifyOwner(
        `⚠️ <b>Начисление бонусов: не всё зачислено</b>\nЗачислено: ${res.credited}, поправлено: ${res.adjusted}. Не удалось: ${res.errors.length}, осталось на следующий запуск: ${res.remaining}.\n${res.errors.slice(0, 3).map((x) => escapeHtml(x)).join("\n")}\nПовторю автоматически при следующем запуске.`
      );
    }
    return NextResponse.json({ ok: true, ...res, errors: res.errors.slice(0, 10) });
  } catch (e) {
    const message = getErrorMessage(e);
    await notifyOwner(`⚠️ <b>Начисление бонусов: сбой запуска</b>\n${escapeHtml(message)}\nПовторю автоматически при следующем запуске.`).catch(() => null);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
