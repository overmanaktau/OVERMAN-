// Раздел «Продажи» для администратора бота: продажи стилистов-консультантов по
// выбранному городу за вчера / последние 7 дней / месяц. Администратор видит
// только свои города (admin_scope: 'city' — свой, 'all' — все).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { money, num, pre } from "@/lib/reports/sales";
import { type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { addDays, monthStartOf, shortDate, todayInAlmaty } from "@/lib/coach/metrics";

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const HIDDEN_NAME = /саяпарк|saya/i;
type Period = "y" | "w" | "m";
const PERIOD_LABEL: Record<Period, string> = { y: "Вчера", w: "Последние 7 дней", m: "Месяц" };

export const ALL_STORES = Object.keys(CITY);

// Вход в раздел: если город один — сразу выбор периода, иначе сначала выбор города.
export async function sendSalesStart(t: Transport, chatId: number | string, stores: string[]) {
  if (stores.length === 1) {
    await sendPeriodMenu(t, chatId, stores[0], false);
    return;
  }
  await t.send(chatId, "📊 <b>Продажи</b>\nВыберите город:", {
    inline_keyboard: [
      ...stores.map((s) => [{ text: CITY[s] ?? s, callback_data: `adm:s:c:${s}` }]),
      [{ text: "Все города", callback_data: "adm:s:c:all" }],
    ],
  });
}

async function sendPeriodMenu(t: Transport, chatId: number | string, store: string, canGoBack: boolean) {
  const rows: { text: string; callback_data: string }[][] = (["y", "w", "m"] as Period[]).map((p) => [
    { text: PERIOD_LABEL[p], callback_data: `adm:s:p:${store}:${p}` },
  ]);
  if (canGoBack) rows.push([{ text: "← Другой город", callback_data: "adm:s" }]);
  await t.send(chatId, `📊 <b>Продажи · ${store === "all" ? "Все города" : (CITY[store] ?? store)}</b>\nЗа какой период?`, {
    inline_keyboard: rows,
  });
}

function rangeFor(period: Period): { from: string; to: string } {
  const today = todayInAlmaty();
  const yesterday = addDays(today, -1);
  if (period === "y") return { from: yesterday, to: yesterday };
  if (period === "w") return { from: addDays(yesterday, -6), to: yesterday };
  return { from: monthStartOf(today), to: yesterday };
}

type Agg = { id: string; name: string; revenue: number; receipts: number };

type Total = { revenue: number; receipts: number };
const avgCheck = (a: Total) => (a.receipts > 0 ? money(a.revenue / a.receipts) : "—");

// Стилисты одного города за период: список по убыванию выручки и планы месяца.
async function cityData(store: string, period: Period): Promise<{ list: Agg[]; planOf: Map<string, number> }> {
  const { from, to } = rangeFor(period);
  const [sales, plans] = await Promise.all([
    supabaseAdmin
      .from("moysklad_employee_sales_daily")
      .select("employee_ms_id, employee_name, revenue, receipts_count")
      .eq("store", store)
      .gte("sale_date", from)
      .lte("sale_date", to),
    period === "m"
      ? supabaseAdmin.from("sales_plan_monthly").select("employee_ms_id, sales_plan").eq("store", store).eq("plan_month", monthStartOf(to))
      : Promise.resolve({ data: [] as { employee_ms_id: string; sales_plan: number | null }[], error: null }),
  ]);
  if (sales.error) throw sales.error;
  if (plans.error) throw plans.error;

  const planOf = new Map<string, number>();
  for (const p of (plans.data ?? []) as { employee_ms_id: string; sales_plan: number | null }[]) {
    if (p.sales_plan !== null) planOf.set(p.employee_ms_id, Number(p.sales_plan));
  }
  const byId = new Map<string, Agg>();
  for (const r of (sales.data ?? []) as { employee_ms_id: string; employee_name: string; revenue: number; receipts_count: number }[]) {
    if (HIDDEN_NAME.test(r.employee_name)) continue;
    const a = byId.get(r.employee_ms_id) ?? { id: r.employee_ms_id, name: r.employee_name, revenue: 0, receipts: 0 };
    a.revenue += Number(r.revenue) || 0;
    a.receipts += Number(r.receipts_count) || 0;
    byId.set(r.employee_ms_id, a);
  }
  return { list: [...byId.values()].sort((a, b) => b.revenue - a.revenue), planOf };
}

function sumOf(list: Total[]): Total {
  return list.reduce((s, a) => ({ revenue: s.revenue + a.revenue, receipts: s.receipts + a.receipts }), { revenue: 0, receipts: 0 });
}

function totalLines(label: string, total: Total): string[] {
  return [`${label.padEnd(13)}${money(total.revenue).padStart(13)}`, `  чеков ${num(total.receipts)} · ср.чек ${avgCheck(total)}`];
}

// Таблица стилистов города (с планом за месяц) и итог по городу.
function cityLines(list: Agg[], planOf: Map<string, number>, period: Period): string[] {
  const lines: string[] = [];
  for (const a of list) {
    lines.push(`${a.name.slice(0, 13).padEnd(13)}${money(a.revenue).padStart(13)}`);
    lines.push(`  чеков ${num(a.receipts)} · ср.чек ${avgCheck(a)}`);
    const plan = planOf.get(a.id);
    if (period === "m" && plan !== undefined && plan > 0) {
      lines.push(`  план ${money(plan)} · ${((a.revenue / plan) * 100).toFixed(1)}%`);
    }
  }
  lines.push("─".repeat(26), ...totalLines("Итого", sumOf(list)));
  return lines;
}

// store — код города или "all" (все города, каждый отдельным блоком и общий итог).
async function buildReport(store: string, period: Period): Promise<string> {
  const { from, to } = rangeFor(period);
  const label = store === "all" ? "Все города" : (CITY[store] ?? store);
  const title = `📊 <b>Продажи · ${label}</b>\n${PERIOD_LABEL[period]}: ${from === to ? shortDate(from) : `${shortDate(from)}–${shortDate(to)}`} (по вчера)`;
  if (from > to) return `${title}\n\nЗа этот период данных ещё нет.`;

  const cities = store === "all" ? ALL_STORES : [store];
  const data = await Promise.all(cities.map((c) => cityData(c, period)));
  if (data.every((d) => d.list.length === 0)) return `${title}\n\nПродаж за этот период нет.`;

  if (store !== "all") return `${title}\n${pre(cityLines(data[0].list, data[0].planOf, period).join("\n"))}`;

  const blocks = cities.map((c, i) =>
    data[i].list.length === 0
      ? `<b>${CITY[c]}</b>: продаж нет.`
      : `<b>${CITY[c]}</b>${pre(cityLines(data[i].list, data[i].planOf, period).join("\n"))}`
  );
  const all = sumOf(data.flatMap((d) => d.list));
  return `${title}\n\n${blocks.join("\n")}\n<b>Всего по городам</b>${pre(totalLines("Итого", all).join("\n"))}`;
}

// Нажатия adm:s… ; stores — города, доступные этому администратору.
export async function handleSalesCallback(parts: string[], t: Transport, chatId: number | string, stores: string[]) {
  // adm:s | adm:s:c:<store> | adm:s:p:<store>:<period>
  const kind = parts[2];
  if (!kind) {
    await sendSalesStart(t, chatId, stores);
    return;
  }
  const store = parts[3];
  // Чужой город — игнорируем; «Все города» — только тому, у кого их больше одного.
  if (store === "all" ? stores.length < 2 : !stores.includes(store)) return;
  if (kind === "c") {
    await sendPeriodMenu(t, chatId, store, stores.length > 1);
    return;
  }
  const period = parts[4] as Period;
  if (kind !== "p" || !(period in PERIOD_LABEL)) return;
  const back: ReplyMarkup = { inline_keyboard: [[{ text: "← Другой период", callback_data: `adm:s:c:${store}` }]] };
  let text: string;
  try {
    text = await buildReport(store, period);
  } catch (e) {
    text = `Не удалось собрать продажи: ${escapeHtml(e instanceof Error ? e.message : String(e))}`;
  }
  await t.send(chatId, text, back);
}

// Условный отчёт для тестового руководителя: выдуманные стилисты и цифры.
export async function sendDemoSales(t: Transport, chatId: number | string) {
  const lines = [
    `${"Айгерим".padEnd(13)}${money(1_240_000).padStart(13)}`,
    "  чеков 41 · ср.чек 30 244 ₸",
    `${"Мадина".padEnd(13)}${money(980_000).padStart(13)}`,
    "  чеков 33 · ср.чек 29 697 ₸",
    `${"Динара".padEnd(13)}${money(655_000).padStart(13)}`,
    "  чеков 25 · ср.чек 26 200 ₸",
    "─".repeat(26),
    `${"Итого".padEnd(13)}${money(2_875_000).padStart(13)}`,
    "  чеков 99 · ср.чек 29 040 ₸",
  ];
  await t.send(
    chatId,
    `🧪 <i>Тестовый режим: сотрудники и цифры выдуманные.</i>\n\n📊 <b>Продажи · Актау</b>\nЗа последние 7 дней\n${pre(lines.join("\n"))}`
  );
}
