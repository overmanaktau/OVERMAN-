// Бонусы за вчера по Актау, сообщение Нуржану каждое утро (решение владельца 09.11.2026):
//  1) командный бонус — общая касса Актау за день: средний чек ≥ 34 000 ₸ и конверсия ≥ 21% → 1 000 ₸ каждому, кто был на смене;
//     средний чек ≥ 36 000 ₸ и конверсия ≥ 23% → 2 500 ₸ (вместо 1 000). Нужны оба показателя;
//  2) личный бонус за чек: чек ≥ 60 000 ₸ → 1 000 ₸, чек ≥ 100 000 ₸ → 2 500 ₸ (вместо 1 000) тому, кто его пробил; за день бонусов может быть несколько.
// Онлайн-продажи (комментарий «онлайн», lib/onlineSales.ts; сомнительные подтверждает Нуржан кнопкой, lib/onlineCheck.ts) считаются как обычные чеки во всех расчётах и дополнительно показываются отдельным блоком (владелец 09.11.2026).
// На смене — тот, у кого за день есть хотя бы один чек в Актау. Возвращённые целиком чеки не считаются.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchRetailDemandsForDate, fetchRetailSalesReturnsForDate, type RetailDemand, type RetailSalesReturn } from "@/lib/moysklad";
import { aggregateSales } from "@/lib/salesAggregate";
import { onlineOnly } from "@/lib/onlineCheck";
import { REGISTER_STORE, registerCounts } from "@/lib/registers";
import { escapeHtml } from "@/lib/telegram";
import { telegramTransport } from "@/lib/coach/bot";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { getErrorMessage } from "@/lib/errors";
import { trim2, trim2Ru } from "@/lib/numFormat";

const NURZHAN_MS_ID = "755c7139-b6de-11f0-0a80-15b80002bbcb"; // Картбаев Нуржан, администратор Актау
const TEAM_TIERS = [
  { avg: 36000, conv: 23, bonus: 2500 },
  { avg: 34000, conv: 21, bonus: 1000 },
];
const CHECK_TIERS = [
  { from: 100000, bonus: 2500 },
  { from: 60000, bonus: 1000 },
];

const ru = (ymd: string) => ymd.split("-").reverse().join(".");
const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const rub = (n: number) => `${trim2Ru(n)} ₸`;

type CheckLine = { number: string; owner: string; amount: number; bonus: number };
export type AktauBonusDay = {
  date: string;
  revenue: number;
  receipts: number;
  avgCheck: number | null;
  visitors: number | null;
  conversion: number | null;
  teamBonus: number; // за человека
  shift: string[];
  perPerson: { name: string; total: number; checks: CheckLine[] }[];
  online: { number: string; owner: string; amount: number; comment: string }[]; // уже входят в расчёт выше, показываются отдельно
};

const isAktau = (d: { retailStore?: { id?: string } | null }, date: string) => {
  const id = d.retailStore?.id;
  return !!id && REGISTER_STORE[id] === "point_1" && registerCounts(id, date);
};

export async function computeAktauBonus(date: string): Promise<AktauBonusDay> {
  const [allDemands, allReturns] = await Promise.all([fetchRetailDemandsForDate(date), fetchRetailSalesReturnsForDate(date)]);
  const store: RetailDemand[] = allDemands.filter((d) => isAktau(d, date));
  const storeReturns: RetailSalesReturn[] = allReturns.filter((r) => isAktau(r, date));

  // общая касса Актау — те же правила возвратов и аннулирования, что в отчётах
  const agg = await aggregateSales(date, store, storeReturns);
  let revenue = 0;
  let receipts = 0;
  for (const a of agg.byRegister.values()) {
    revenue += a.revenue;
    receipts += a.receipts;
  }
  const avgCheck = receipts > 0 ? revenue / receipts : null;
  const { data: traffic, error } = await supabaseAdmin.from("traffic_entries").select("traffic_fact").eq("store", "point_1").eq("entry_date", date).maybeSingle();
  if (error) throw error;
  const visitors = traffic?.traffic_fact !== null && traffic?.traffic_fact !== undefined ? Number(traffic.traffic_fact) : null;
  const conversion = visitors && visitors > 0 ? (receipts / visitors) * 100 : null;
  const tier = avgCheck !== null && conversion !== null ? TEAM_TIERS.find((t) => avgCheck >= t.avg && conversion >= t.conv) : undefined;

  const shift = [...new Set([...agg.byEmployee.values()].filter((e) => e.receipts > 0).map((e) => e.name))].sort((a, b) => a.localeCompare(b, "ru"));

  // личные бонусы за чеки: сумма чека минус возвраты по нему за этот день; чек, возвращённый целиком, не считается
  const returnedByDemand = new Map<string, number>();
  for (const r of storeReturns) {
    const href = r.demand?.meta?.href;
    if (href) returnedByDemand.set(href, (returnedByDemand.get(href) ?? 0) + (r.sum ?? 0) / 100);
  }
  const people = new Map<string, { name: string; total: number; checks: CheckLine[] }>();
  for (const d of store) {
    const returned = d.meta?.href ? (returnedByDemand.get(d.meta.href) ?? 0) : 0;
    const amount = (d.sum ?? 0) / 100;
    if (returned >= amount - 1) continue;
    const net = amount - returned;
    const tierCheck = CHECK_TIERS.find((t) => net >= t.from);
    if (!tierCheck) continue;
    const name = d.owner?.name ?? "—";
    const p = people.get(name) ?? { name, total: 0, checks: [] };
    p.total += tierCheck.bonus;
    p.checks.push({ number: d.name ?? "—", owner: name, amount: net, bonus: tierCheck.bonus });
    people.set(name, p);
  }
  const perPerson = [...people.values()].map((p) => ({ ...p, checks: p.checks.sort((a, b) => b.amount - a.amount) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ru"));

  const online = (await onlineOnly(store))
    .map((d) => ({ number: d.name ?? "—", owner: d.owner?.name ?? "—", amount: (d.sum ?? 0) / 100, comment: (d.description ?? "").trim() }));

  return { date, revenue, receipts, avgCheck, visitors, conversion, teamBonus: tier?.bonus ?? 0, shift, perPerson, online };
}

export function buildBonusMessage(b: AktauBonusDay): string {
  const lines: string[] = [`🎯 <b>Бонусы за ${dm(b.date)} · Актау</b>`, ""];
  const base = TEAM_TIERS[TEAM_TIERS.length - 1];
  if (b.avgCheck === null || b.conversion === null) {
    lines.push("Командный бонус: не посчитан");
    lines.push(b.receipts === 0 ? "В этот день не было чеков." : "Нет данных по посетителям за этот день — конверсию посчитать нельзя.");
  } else if (b.teamBonus > 0) {
    const t = TEAM_TIERS.find((x) => x.bonus === b.teamBonus) ?? base;
    lines.push(`Командный бонус: ${rub(b.teamBonus)} каждому на смене ✅`);
    lines.push(`Средний чек ${rub(Math.round(b.avgCheck))} (от ${trim2Ru(t.avg)} ✅) · Конверсия ${trim2(b.conversion, ",")}% (от ${t.conv}% ✅)`);
    lines.push(`На смене: ${escapeHtml(b.shift.join(", "))} (${b.shift.length} чел.) — ${rub(b.teamBonus * b.shift.length)}`);
  } else {
    lines.push("Командный бонус: нет");
    lines.push(`Средний чек ${rub(Math.round(b.avgCheck))} — нужно от ${trim2Ru(base.avg)} ${b.avgCheck >= base.avg ? "✅" : "❌"}`);
    lines.push(`Конверсия ${trim2(b.conversion, ",")}% — нужно от ${base.conv}% ${b.conversion >= base.conv ? "✅" : "❌"}`);
  }
  lines.push("");
  if (b.perPerson.length === 0) {
    lines.push("За чеки: нет");
  } else {
    lines.push("Бонусы за чеки:");
    for (const p of b.perPerson) {
      lines.push(`• ${escapeHtml(p.name)} — ${rub(p.total)}`);
      lines.push(`  ${p.checks.map((c) => `${rub(c.amount)} (${trim2Ru(c.bonus)})`).join(", ")}`);
    }
    lines.push("");
    lines.push(`Всего за чеки: ${rub(b.perPerson.reduce((a, p) => a + p.total, 0))}`);
  }
  if (b.online.length > 0) {
    lines.push("", `Из них онлайн: ${b.online.length} шт. на ${rub(b.online.reduce((a, o) => a + o.amount, 0))} (входят в расчёт выше)`);
    for (const o of b.online) lines.push(`• чек ${escapeHtml(o.number)} · ${escapeHtml(o.owner)} · ${rub(o.amount)} · «${escapeHtml(o.comment)}»`);
  }
  return lines.join("\n");
}

// Утреннее сообщение Нуржану за вчера; один раз в день (coach_messages_sent, kind «bonus»).
export async function sendAktauBonusToNurzhan(date: string, dry = false): Promise<{ sent: boolean; reason?: string; text?: string }> {
  const { data: user, error } = await supabaseAdmin.from("coach_users").select("id, telegram_chat_id").eq("employee_ms_id", NURZHAN_MS_ID).eq("status", "approved").maybeSingle();
  if (error) throw error;
  if (!user) return { sent: false, reason: "Нуржан не подключён к боту-помощнику" };
  if (!dry) {
    const { data: already } = await supabaseAdmin.from("coach_messages_sent").select("id").eq("user_id", user.id).eq("kind", "bonus").eq("ref_date", date).maybeSingle();
    if (already) return { sent: false, reason: "уже отправлено" };
  }
  try {
    const text = buildBonusMessage(await computeAktauBonus(date));
    if (dry) return { sent: false, reason: "dry", text };
    await telegramTransport.send(user.telegram_chat_id, text);
    await supabaseAdmin.from("coach_messages_sent").insert({ user_id: user.id, kind: "bonus", ref_date: date });
    return { sent: true, text };
  } catch (e) {
    if (!dry) await notifyOwner(`⚠️ <b>Сообщение о бонусах Нуржану за ${ru(date)} не отправлено</b>\nПричина: ${getErrorMessage(e)}`);
    throw e;
  }
}
