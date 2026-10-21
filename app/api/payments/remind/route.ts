import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { escapeHtml } from "@/lib/telegram";
import { todayAlmaty } from "@/lib/kassa/sync";

export const maxDuration = 60;

// Напоминание владельцу об оплатах (Настройки → Оплаты): за 14 и за 7 дней до конца срока и в день окончания (pg_cron, ежедневно 10:00 по Алматы, в личку бота-помощника).
// ?dry=1 — вернуть текст и ничего не отправлять.
const REMIND_DAYS = [14, 7, 0];
const STORE_NAME: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const ru = (ymd: string) => ymd.split("-").reverse().join(".");
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);

type Row = { name: string; pay_to: string | null; amount: number | null; store: string | null; paid_until: string; comment: string | null };

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  try {
    const today = todayAlmaty();
    const { data, error } = await supabaseAdmin.from("pay_services").select("name, pay_to, amount, store, paid_until, comment").order("paid_until");
    if (error) throw error;
    const due = ((data ?? []) as Row[]).filter((r) => REMIND_DAYS.includes(daysBetween(today, r.paid_until)));
    if (due.length === 0) return NextResponse.json({ ok: true, sent: false, due: 0 });
    const line = (r: Row) => {
      const left = daysBetween(today, r.paid_until);
      const when = left === 0 ? "<b>срок заканчивается сегодня</b>" : `осталось ${left} дн. (до ${ru(r.paid_until)})`;
      const parts = [`• <b>${escapeHtml(r.name)}</b> — ${when}`];
      if (r.pay_to) parts.push(`  куда платить: ${escapeHtml(r.pay_to)}`);
      if (r.amount !== null) parts.push(`  сумма: ${Math.round(Number(r.amount)).toLocaleString("ru-RU")} ₸${r.store ? ` · ${STORE_NAME[r.store] ?? r.store}` : ""}`);
      else if (r.store) parts.push(`  ${STORE_NAME[r.store] ?? r.store}`);
      return parts.join("\n");
    };
    const text = `💳 <b>Оплаты: скоро заканчивается срок</b>\n\n${due.map(line).join("\n\n")}`;
    if (!dry) await notifyOwner(text);
    return NextResponse.json({ ok: true, sent: !dry, due: due.length, text: dry ? text : undefined });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
