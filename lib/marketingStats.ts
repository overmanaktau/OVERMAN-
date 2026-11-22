// Расчёт и PDF «Статистика маркетинга» — один код для страницы «Маркетинг → Статистика» (кнопка «Скачать PDF») и для понедельничной отправки владельцу
// (lib/reports/marketingWeekly.ts). Нормы (зелёный / жёлтый / красный): план от 100% (внимание от 90%), цена посетителя до 500 ₸ (до 600),
// маркетинг от среднего чека до 8% (до 9%).
import { trim2Ru } from "@/lib/numFormat";
import { ruPeriod } from "@/lib/fileNames";
import type { PdfDoc, PdfTone } from "@/lib/exportPdf";

export const CHANNEL_DEFS = [
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
  { key: "instagram_public", label: "Instagram паблик" },
  { key: "flyer", label: "Раздача флаеров" },
  { key: "two_gis", label: "2ГИС карта" },
] as const;

export const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]; // как Date#getDay()

export function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function ymd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

export type TrafficRow = {
  entry_date: string;
  traffic_plan: number | null;
  traffic_fact: number | null;
  instagram: number | null;
  tiktok: number | null;
  instagram_public: number | null;
  flyer: number | null;
  two_gis: number | null;
};

export type SalesTotals = { revenue: number; receipts: number };
export type StatsRange = { start: Date; end: Date; prevStart: Date; prevEnd: Date; hasPrev: boolean };

export function sumTraffic(rows: TrafficRow[]) {
  const totals = { plan: 0, fact: 0, instagram: 0, tiktok: 0, instagram_public: 0, flyer: 0, two_gis: 0 };
  for (const r of rows) {
    totals.plan += r.traffic_plan ?? 0;
    totals.fact += r.traffic_fact ?? 0;
    totals.instagram += r.instagram ?? 0;
    totals.tiktok += r.tiktok ?? 0;
    totals.instagram_public += r.instagram_public ?? 0;
    totals.flyer += r.flyer ?? 0;
    totals.two_gis += r.two_gis ?? 0;
  }
  return totals;
}

export function pctChange(curr: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((curr - prev) / prev) * 100;
}

// Посетители и остальные числа статистики: целое — без дробной части, иначе два знака после запятой (lib/numFormat.ts)
export const trafficText = trim2Ru;
export function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}

export function spendVsCheckTone(pct: number): "positive" | "warning" | "negative" {
  if (pct <= 8) return "positive";
  if (pct <= 9) return "warning";
  return "negative";
}

export function costPerVisitorTone(value: number): "positive" | "warning" | "negative" {
  if (value <= 500) return "positive";
  if (value <= 600) return "warning";
  return "negative";
}

export function planCompletionTone(pct: number): "positive" | "warning" | "negative" {
  if (pct >= 100) return "positive";
  if (pct >= 90) return "warning";
  return "negative";
}

export type StatsData = {
  current: TrafficRow[];
  previous: TrafficRow[];
  salesTotals: SalesTotals;
  prevSalesTotals: SalesTotals;
  expensesTotal: number;
  prevExpensesTotal: number;
};

// Все показатели страницы «Статистика» по загруженным данным (текущий и предыдущий период)
export function computeStats({ current, previous, salesTotals, prevSalesTotals, expensesTotal, prevExpensesTotal }: StatsData) {
  const totals = sumTraffic(current);
  const prevTotals = sumTraffic(previous);

  const planCompletionPct = totals.plan > 0 ? (totals.fact / totals.plan) * 100 : null;
  const prevPlanCompletionPct = prevTotals.plan > 0 ? (prevTotals.fact / prevTotals.plan) * 100 : null;
  const planCompletionChange = planCompletionPct !== null && prevPlanCompletionPct !== null ? pctChange(planCompletionPct, prevPlanCompletionPct) : null;
  const trafficShortfall = Math.max(0, totals.plan - totals.fact);

  const channelTotal = totals.instagram + totals.tiktok + totals.instagram_public + totals.flyer + totals.two_gis;
  const totalSpend = channelTotal + expensesTotal;

  const prevChannelTotal = prevTotals.instagram + prevTotals.tiktok + prevTotals.instagram_public + prevTotals.flyer + prevTotals.two_gis;
  const prevTotalSpend = prevChannelTotal + prevExpensesTotal;

  const costPerVisitor = totals.fact > 0 ? totalSpend / totals.fact : null;
  const prevCostPerVisitor = prevTotals.fact > 0 ? prevTotalSpend / prevTotals.fact : null;

  const spendChange = pctChange(totalSpend, prevTotalSpend);
  const costChange = costPerVisitor !== null && prevCostPerVisitor !== null ? pctChange(costPerVisitor, prevCostPerVisitor) : null;
  const expensesChange = pctChange(expensesTotal, prevExpensesTotal);

  // «Покупатель» = чек в МойСклад (receipts_count), в отличие от «посетителя» (traffic_fact) — не каждый посетитель делает покупку.
  const avgCheck = salesTotals.receipts > 0 ? salesTotals.revenue / salesTotals.receipts : null;
  const prevAvgCheck = prevSalesTotals.receipts > 0 ? prevSalesTotals.revenue / prevSalesTotals.receipts : null;

  const costPerBuyer = salesTotals.receipts > 0 ? totalSpend / salesTotals.receipts : null;
  const prevCostPerBuyer = prevSalesTotals.receipts > 0 ? prevTotalSpend / prevSalesTotals.receipts : null;
  const costPerBuyerChange = costPerBuyer !== null && prevCostPerBuyer !== null ? pctChange(costPerBuyer, prevCostPerBuyer) : null;

  // Конверсия посетителей в покупателей: чек / посетитель × 100.
  const conversionPct = totals.fact > 0 ? (salesTotals.receipts / totals.fact) * 100 : null;

  // Только расходы по каналам — без доп. расходов, в отличие от «Цена одного покупателя», которая считает весь маркетинговый расход.
  const channelCostPerBuyer = salesTotals.receipts > 0 ? channelTotal / salesTotals.receipts : null;
  const prevChannelCostPerBuyer = prevSalesTotals.receipts > 0 ? prevChannelTotal / prevSalesTotals.receipts : null;

  const spendVsCheckPct = channelCostPerBuyer !== null && avgCheck !== null && avgCheck > 0 ? (channelCostPerBuyer / avgCheck) * 100 : null;
  const prevSpendVsCheckPct = prevChannelCostPerBuyer !== null && prevAvgCheck !== null && prevAvgCheck > 0 ? (prevChannelCostPerBuyer / prevAvgCheck) * 100 : null;
  const spendVsCheckChange = spendVsCheckPct !== null && prevSpendVsCheckPct !== null ? pctChange(spendVsCheckPct, prevSpendVsCheckPct) : null;

  return {
    totals, prevTotals,
    planCompletionPct, prevPlanCompletionPct, planCompletionChange, trafficShortfall,
    channelTotal, totalSpend, prevChannelTotal, prevTotalSpend,
    costPerVisitor, prevCostPerVisitor, spendChange, costChange, expensesChange,
    avgCheck, prevAvgCheck, costPerBuyer, prevCostPerBuyer, costPerBuyerChange,
    conversionPct, channelCostPerBuyer, prevChannelCostPerBuyer,
    spendVsCheckPct, prevSpendVsCheckPct, spendVsCheckChange,
  };
}

export type StatsDocInput = StatsData & {
  range: StatsRange;
  salesByDate: Map<string, { revenue: number; receipts: number }>;
  titleSuffix?: string; // «Актау» — добавляется к заголовку отчёта
};

// PDF: карточки с цветом по нормам, таблица «все показатели: норма и статус», что требует внимания, расходы по каналам, статистика по дням.
export function buildMarketingStatsDoc(input: StatsDocInput): PdfDoc {
  const { range, salesByDate, current, salesTotals, prevSalesTotals, expensesTotal, prevExpensesTotal } = input;
  const s = computeStats(input);
  const { totals, prevTotals, planCompletionPct, prevPlanCompletionPct, channelTotal, totalSpend, prevChannelTotal, prevTotalSpend, costPerVisitor, prevCostPerVisitor, avgCheck, prevAvgCheck, costPerBuyer, prevCostPerBuyer, conversionPct, spendVsCheckPct, prevSpendVsCheckPct } = s;

  const ru = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
  const hasPrev = range.hasPrev;
  const toneOf = (x: "positive" | "warning" | "negative"): PdfTone => (x === "positive" ? "good" : x === "warning" ? "warn" : "bad");
  const WORD: Record<PdfTone, string> = { good: "НОРМА", warn: "ВНИМАНИЕ", bad: "ПРОБЛЕМА" };
  const pv = (v: number | null) => (hasPrev ? v : null);
  const pctText = (n: number) => `${trim2Ru(n)}%`;
  const was = (v: number | null, f: (n: number) => string) => (v === null ? "" : ` · было ${f(v)}`);
  const chgText = (cur: number, prev: number) => {
    const v = pctChange(cur, prev);
    return v === null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${trim2Ru(Math.abs(v))}%`;
  };
  // для показателей без нормы: лучше / хуже, чем в прошлом периоде («больше — лучше» или «меньше — лучше»)
  const vs = (cur: number | null, prev: number | null, better: "up" | "down"): PdfTone | null => {
    if (cur === null || prev === null || cur === prev) return null;
    return (cur > prev) === (better === "up") ? "good" : "bad";
  };
  const vsWord = (x: PdfTone | null) => (x === "good" ? "лучше, чем раньше" : x === "bad" ? "хуже, чем раньше" : "как раньше");

  const prevConversion = prevTotals.fact > 0 ? (prevSalesTotals.receipts / prevTotals.fact) * 100 : null;
  const prevDone = pv(prevPlanCompletionPct);
  const prevVisitor = pv(prevCostPerVisitor);
  const prevBuyer = pv(prevCostPerBuyer);
  const prevCheckPct = pv(prevSpendVsCheckPct);
  const prevConv = pv(prevConversion);
  const prevAvg = pv(prevAvgCheck);

  const planT = planCompletionPct === null ? null : toneOf(planCompletionTone(planCompletionPct));
  const visitorT = costPerVisitor === null ? null : toneOf(costPerVisitorTone(costPerVisitor));
  const checkT = spendVsCheckPct === null ? null : toneOf(spendVsCheckTone(spendVsCheckPct));
  const buyerT = vs(costPerBuyer, prevBuyer, "down");
  const visitorsT = vs(totals.fact, hasPrev ? prevTotals.fact : null, "up");
  const receiptsT = vs(salesTotals.receipts, hasPrev ? prevSalesTotals.receipts : null, "up");
  const convT = vs(conversionPct, prevConv, "up");
  const avgT = vs(avgCheck, prevAvg, "up");

  const kpis: NonNullable<PdfDoc["kpis"]> = [
    { label: "Выполнение плана по трафику", value: planCompletionPct === null ? "не задан" : pctText(planCompletionPct), note: planT === null ? "план трафика не внесён" : `${WORD[planT]} · норма от 100%`, tone: planT ?? "warn" },
    { label: "Общий расход на маркетинг", value: money(totalSpend), note: hasPrev && prevTotalSpend > 0 ? `${chgText(totalSpend, prevTotalSpend)} к прошлому периоду` : "в прошлом периоде расхода не было" },
    { label: "Доп. расходы", value: money(expensesTotal), note: hasPrev && prevExpensesTotal > 0 ? `${chgText(expensesTotal, prevExpensesTotal)} к прошлому периоду` : "не вносились" },
    { label: "Цена одного посетителя", value: costPerVisitor === null ? "—" : money(costPerVisitor), note: visitorT === null ? undefined : `${WORD[visitorT]} · норма до 500 ₸${was(prevVisitor, money)}`, tone: visitorT ?? undefined },
    { label: "Цена одного покупателя", value: costPerBuyer === null ? "—" : money(costPerBuyer), note: costPerBuyer === null ? undefined : `${vsWord(buyerT)}${was(prevBuyer, money)}` },
    { label: "Маркетинг, % от среднего чека", value: spendVsCheckPct === null ? "—" : pctText(spendVsCheckPct), note: checkT === null ? undefined : `${WORD[checkT]} · норма до 8% · чек ${avgCheck === null ? "—" : money(avgCheck)}`, tone: checkT ?? undefined },
  ];

  type Row = { label: string; value: string; norm: string; status: string; tone: PdfTone | null; prev: string };
  const rows: Row[] = [
    { label: "Выполнение плана по трафику", value: planCompletionPct === null ? "не задан" : pctText(planCompletionPct), norm: "от 100%", status: planT === null ? "план не внесён" : WORD[planT], tone: planT ?? "warn", prev: prevDone === null ? "—" : pctText(prevDone) },
    { label: "Цена одного посетителя", value: costPerVisitor === null ? "—" : money(costPerVisitor), norm: "до 500 ₸ (внимание до 600 ₸)", status: visitorT ? WORD[visitorT] : "—", tone: visitorT, prev: prevVisitor === null ? "—" : money(prevVisitor) },
    { label: "Маркетинг, % от среднего чека", value: spendVsCheckPct === null ? "—" : pctText(spendVsCheckPct), norm: "до 8% (внимание до 9%)", status: checkT ? WORD[checkT] : "—", tone: checkT, prev: prevCheckPct === null ? "—" : pctText(prevCheckPct) },
    { label: "Цена одного покупателя", value: costPerBuyer === null ? "—" : money(costPerBuyer), norm: "нормы нет, меньше — лучше", status: costPerBuyer === null ? "—" : vsWord(buyerT), tone: buyerT, prev: prevBuyer === null ? "—" : money(prevBuyer) },
    { label: "Общий расход на маркетинг", value: money(totalSpend), norm: "нормы нет", status: "—", tone: null, prev: hasPrev ? money(prevTotalSpend) : "—" },
    { label: "Посетители", value: trafficText(totals.fact), norm: "нормы нет, больше — лучше", status: vsWord(visitorsT), tone: visitorsT, prev: hasPrev ? trafficText(prevTotals.fact) : "—" },
    { label: "Чеки (покупки)", value: String(salesTotals.receipts), norm: "нормы нет, больше — лучше", status: vsWord(receiptsT), tone: receiptsT, prev: hasPrev ? String(prevSalesTotals.receipts) : "—" },
    { label: "Из 100 посетителей купили", value: conversionPct === null ? "—" : trim2Ru(conversionPct), norm: "нормы нет, больше — лучше", status: conversionPct === null ? "—" : vsWord(convT), tone: convT, prev: prevConv === null ? "—" : trim2Ru(prevConv) },
    { label: "Средний чек", value: avgCheck === null ? "—" : money(avgCheck), norm: "нормы нет, больше — лучше", status: avgCheck === null ? "—" : vsWord(avgT), tone: avgT, prev: prevAvg === null ? "—" : money(prevAvg) },
  ];

  const attn: string[] = [];
  if (planCompletionPct === null) attn.push("План трафика на этот период не внесён — выполнение плана посчитать нельзя.");
  else if (planT !== "good") attn.push(`План по трафику выполнен на ${pctText(planCompletionPct)} — ниже нормы (от 100%).`);
  if (visitorT && visitorT !== "good" && costPerVisitor !== null) attn.push(`Цена одного посетителя ${money(costPerVisitor)} — выше нормы (до 500 ₸).`);
  if (checkT && checkT !== "good" && spendVsCheckPct !== null) attn.push(`Маркетинг съел ${pctText(spendVsCheckPct)} среднего чека — выше нормы (до 8%).`);
  for (const r of rows) if (r.tone === "bad" && r.norm.startsWith("нормы нет")) attn.push(`${r.label}: ${r.value} — хуже, чем в прошлом периоде (${r.prev}).`);
  if (attn.length === 0) attn.push("По нормам портала проблем нет.");

  const chSum = CHANNEL_DEFS.map((c) => ({ label: c.label, cur: totals[c.key], prev: hasPrev ? prevTotals[c.key] : 0 })).sort((a, b) => b.cur - a.cur);
  const chRows: (string | number)[][] = chSum
    .filter((x) => x.cur > 0 || x.prev > 0)
    .map((x) => [x.label, money(x.cur), channelTotal > 0 ? pctText((x.cur / channelTotal) * 100) : "—", hasPrev ? money(x.prev) : "—", x.prev > 0 ? chgText(x.cur, x.prev) : "—"]);
  chRows.push(["Всего по каналам", money(channelTotal), "100%", hasPrev ? money(prevChannelTotal) : "—", prevChannelTotal > 0 ? chgText(channelTotal, prevChannelTotal) : "—"]);

  // при нескольких городах за одну дату строк несколько — складываем
  const byDate = new Map<string, { fact: number; spend: number }>();
  for (const r of current) {
    const a = byDate.get(r.entry_date) ?? { fact: 0, spend: 0 };
    a.fact += r.traffic_fact ?? 0;
    a.spend += CHANNEL_DEFS.reduce((sum, c) => sum + (r[c.key] ?? 0), 0);
    byDate.set(r.entry_date, a);
  }
  const days: (string | number)[][] = [];
  for (let cursor = new Date(range.start); cursor <= range.end; cursor = addDays(cursor, 1)) {
    const key = ymd(cursor);
    const sl = salesByDate.get(key);
    const fact = byDate.get(key)?.fact ?? 0;
    const sp = byDate.get(key)?.spend ?? 0;
    days.push([
      `${WEEKDAYS[cursor.getDay()]}, ${pad2(cursor.getDate())}.${pad2(cursor.getMonth() + 1)}`,
      trafficText(fact),
      sl ? String(sl.receipts) : "—",
      sl && fact > 0 ? trim2Ru((sl.receipts / fact) * 100) : "—",
      sl && sl.receipts > 0 ? money(sl.revenue / sl.receipts) : "—",
      money(sp),
      fact > 0 ? money(sp / fact) : "—",
    ]);
  }
  days.push(["Итого", trafficText(totals.fact), String(salesTotals.receipts), conversionPct === null ? "—" : trim2Ru(conversionPct), avgCheck === null ? "—" : money(avgCheck), money(channelTotal), totals.fact > 0 ? money(channelTotal / totals.fact) : "—"]);

  const prevLabel = hasPrev ? `Прошлый период: ${ru(range.prevStart)}${range.prevStart.getTime() === range.prevEnd.getTime() ? "" : ` — ${ru(range.prevEnd)}`}. ` : "";
  const title = input.titleSuffix ? `Статистика маркетинга · ${input.titleSuffix}` : "Статистика маркетинга";
  return {
    fileName: `${input.titleSuffix ? `Статистика ${input.titleSuffix} ` : "Статистика "}${ruPeriod(ymd(range.start), ymd(range.end))}`,
    title,
    subtitle: `${ru(range.start)} — ${ru(range.end)}`,
    meta: [`${prevLabel}Цвета: зелёный — норма, жёлтый — внимание, красный — проблема. Нормы те же, что на карточках страницы «Маркетинг — Статистика».`],
    orientation: "landscape",
    fixedKpis: true,
    kpis,
    sections: [
      {
        title: "Все показатели: норма и статус",
        fixed: true,
        headers: ["Показатель", "Сейчас", "Норма", "Статус", "В прошлом периоде"],
        rows: rows.map((r) => [r.label, r.value, r.norm, r.status, r.prev]),
        tones: rows.map((r) => [null, null, null, r.tone, null]),
        align: ["left", "right", "left", "left", "right"],
        widths: [2.6, 1.4, 2.6, 1.9, 1.5],
      },
      { title: "Что требует внимания", fixed: true, headers: ["Коротко"], rows: attn.map((a) => [a]), align: ["left"], fontSize: 9.4 },
      {
        title: "Куда ушли деньги",
        fixed: true,
        headers: ["Канал", "Потратили", "Доля", "В прошлом периоде", "Изменение"],
        rows: chRows,
        rowKinds: chRows.map((_, i) => (i === chRows.length - 1 ? "total" : "normal")),
        align: ["left", "right", "right", "right", "right"],
        widths: [2.4, 1.6, 1, 1.6, 1.2],
      },
      {
        title: "Статистика по дням",
        fixed: true,
        note: "«Из 100 купили» — сколько человек из ста вошедших сделали покупку. «Цена посетителя» — расход по каналам ÷ посетители за день.",
        headers: ["День", "Посетителей", "Чеков", "Из 100 купили", "Средний чек", "Расход по каналам", "Цена посетителя"],
        rows: days,
        rowKinds: days.map((_, i) => (i === days.length - 1 ? "total" : "normal")),
        align: ["left", "right", "right", "right", "right", "right", "right"],
      },
    ],
  };
}

