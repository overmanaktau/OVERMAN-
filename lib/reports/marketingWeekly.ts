// Недельный отчёт «Статистика маркетинга» владельцу (бот СММ, только роль «администратор»): тот же PDF, что даёт кнопка на странице
// «Маркетинг → Статистика» (lib/marketingStats.ts), за прошлую неделю против позапрошлой, отдельно по каждому городу.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildPdf } from "@/lib/exportPdf";
import { buildMarketingStatsDoc, type TrafficRow } from "@/lib/marketingStats";
import { CITIES, type CityKey } from "@/lib/smm/config";
import { almatyToday, lastWeek, loadFonts } from "@/lib/smm/targetReport";
import { sendSmmDocument } from "@/lib/smm/telegram";
import { approvedUsers, markSent, wasSent } from "@/lib/smm/users";
import { escapeHtml } from "@/lib/telegram";

const STORE: Record<CityKey, string> = { aktau: "point_1", aktobe: "point_3" };

const ruDate = (s: string) => s.split("-").reverse().join(".");
const toLocal = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d); // как на странице: даты периода — «местные»
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function loadPeriod(store: string, registerIds: string[], from: string, to: string) {
  const [traffic, sales, expenses] = await Promise.all([
    supabaseAdmin.from("traffic_entries").select("entry_date, traffic_plan, traffic_fact, instagram, tiktok, instagram_public, flyer, two_gis").eq("store", store).gte("entry_date", from).lte("entry_date", to),
    registerIds.length > 0
      ? supabaseAdmin.from("moysklad_sales_daily").select("sale_date, revenue, receipts_count").in("register_id", registerIds).gte("sale_date", from).lte("sale_date", to)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("extra_expenses").select("amount").gte("expense_date", from).lte("expense_date", to),
  ]);
  if (traffic.error) throw traffic.error;
  if (sales.error) throw sales.error;
  if (expenses.error) throw expenses.error;
  const salesByDate = new Map<string, { revenue: number; receipts: number }>();
  for (const r of (sales.data ?? []) as { sale_date: string; revenue: number; receipts_count: number }[]) {
    const p = salesByDate.get(r.sale_date) ?? { revenue: 0, receipts: 0 };
    salesByDate.set(r.sale_date, { revenue: p.revenue + r.revenue, receipts: p.receipts + r.receipts_count });
  }
  const totals = [...salesByDate.values()].reduce((a, v) => ({ revenue: a.revenue + v.revenue, receipts: a.receipts + v.receipts }), { revenue: 0, receipts: 0 });
  return {
    rows: (traffic.data ?? []) as TrafficRow[],
    salesByDate,
    salesTotals: totals,
    expensesTotal: ((expenses.data ?? []) as { amount: number | null }[]).reduce((a, e) => a + (e.amount ?? 0), 0),
  };
}

export type MarketingReport = { title: string; fileName: string; bytes: Uint8Array };

// PDF «Статистика маркетинга» по городу за период (предыдущий период — такой же длины сразу перед ним)
export async function buildMarketingReport(city: CityKey, from: string, to: string): Promise<MarketingReport> {
  const store = STORE[city];
  const { data: regs, error } = await supabaseAdmin.from("moysklad_registers").select("id, store").eq("store", store);
  if (error) throw error;
  const registerIds = (regs ?? []).map((r) => r.id as string);
  const start = toLocal(from);
  const end = toLocal(to);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  const [cur, prev] = await Promise.all([loadPeriod(store, registerIds, from, to), loadPeriod(store, registerIds, fmt(prevStart), fmt(prevEnd))]);
  const doc = buildMarketingStatsDoc({
    range: { start, end, prevStart, prevEnd, hasPrev: true },
    current: cur.rows,
    previous: prev.rows,
    salesByDate: cur.salesByDate,
    salesTotals: cur.salesTotals,
    prevSalesTotals: prev.salesTotals,
    expensesTotal: cur.expensesTotal,
    prevExpensesTotal: prev.expensesTotal,
    titleSuffix: CITIES[city].title,
  });
  const pdf = buildPdf(doc, await loadFonts());
  return { title: doc.title, fileName: `${doc.fileName}.pdf`, bytes: new Uint8Array(pdf.output("arraybuffer")) };
}

// Еженедельная отправка: только владельцу (роль «администратор» в боте СММ). Повторный запуск за ту же неделю ничего не шлёт, пока не указан force.
export async function sendWeeklyMarketingReport(opts: { city: CityKey; from?: string; to?: string; force?: boolean; dry?: boolean }) {
  const week = opts.from && opts.to ? { from: opts.from, to: opts.to } : lastWeek(almatyToday());
  const admins = (await approvedUsers()).filter((u) => u.role === "admin");
  const kind = `marketing_week_${opts.city}`;
  const pending = [];
  for (const u of admins) if (opts.force || !(await wasSent(u.id, kind, week.from))) pending.push(u);
  if (pending.length === 0) return { week, city: opts.city, skipped: "уже отправлено или нет получателя" };
  const report = await buildMarketingReport(opts.city, week.from, week.to);
  if (opts.dry) return { week, city: opts.city, file: report.fileName, kb: Math.round(report.bytes.length / 1024) };
  for (const u of pending) {
    await sendSmmDocument(u.telegram_chat_id, report.fileName, report.bytes, `📊 <b>${escapeHtml(report.title)}</b>\n${ruDate(week.from)} — ${ruDate(week.to)}, против предыдущей недели`);
    await markSent(u.id, kind, week.from);
  }
  return { week, city: opts.city, file: report.fileName, kb: Math.round(report.bytes.length / 1024) };
}
