"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// ── Типы справочников ──────────────────────────────────────────────────────
export type FinAccount = {
  id: number;
  name: string;
  kind: "cash" | "bank" | "card" | "other";
  store: string | null;
  opening_balance: number;
  opening_date: string;
  active: boolean;
  sort: number;
};
// Показатели ОПИУ в порядке отчёта владельца; статья относится к одному из них.
export type OpiuGroup =
  | "revenue"
  | "cogs"
  | "marketing"
  | "payroll"
  | "fixed"
  | "variable"
  | "bank"
  | "tax_other"
  | "tax_3"
  | "other_income"
  | "other_expense";
export type FinCategory = {
  id: number;
  parent_id: number | null;
  name: string;
  kind: "income" | "expense";
  opiu_group: OpiuGroup | null;
  require_supplier: boolean; // при внесении обязателен выбор поставщика
  auto_tax: boolean; // сумма считается автоматически (процент от безналичных поступлений)
  active: boolean;
  sort: number;
};
export type FinPartner = { id: number; name: string; phone: string | null; note: string | null; active: boolean };
export type FinSupplier = {
  id: number;
  name: string;
  bin: string | null;
  phone: string | null;
  payment_terms_days: number | null;
  note: string | null;
  active: boolean;
};
export type FinSettings = {
  auto_revenue: boolean;
  auto_cogs: boolean;
  debt_alert_days: number;
  low_balance_limit: number;
  auto_tax: boolean;
  tax_rate: number;
};
export type FinOperation = {
  id: number;
  op_date: string;
  kind: "income" | "expense" | "transfer";
  amount: number;
  account_id: number;
  to_account_id: number | null;
  category_id: number | null;
  store: string | null;
  supplier_id: number | null;
  debt_id: number | null;
  comment: string | null;
  unlock_expires_at: string | null; // окно правки по одобренному запросу
};

export const ACCOUNT_KIND_LABEL: Record<FinAccount["kind"], string> = {
  cash: "Наличные (касса)",
  bank: "Расчётный счёт",
  card: "Карта",
  other: "Другое",
};

export const OPIU_GROUP_LABEL: Record<OpiuGroup, string> = {
  revenue: "Оборот",
  cogs: "Себестоимость",
  marketing: "Маркетинговые расходы",
  payroll: "ФОТ",
  fixed: "Постоянные расходы",
  variable: "Переменные расходы",
  bank: "Комиссия банка",
  tax_other: "Налоги - отчисления разные",
  tax_3: "Налоги 3%",
  other_income: "Прочие доходы",
  other_expense: "Прочие расходы",
};

// Расходные показатели в том порядке, в каком они идут в ОПИУ после валовой прибыли.
export const EXPENSE_INDICATORS: OpiuGroup[] = ["marketing", "payroll", "fixed", "variable", "bank", "tax_other", "tax_3"];

const DEFAULT_SETTINGS: FinSettings = { auto_revenue: true, auto_cogs: true, debt_alert_days: 7, low_balance_limit: 0, auto_tax: true, tax_rate: 3 };

// ── Форматирование и даты ──────────────────────────────────────────────────
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const rounded = Math.round(n);
  return rounded.toLocaleString("ru-RU").replace(/ /g, " ") + " ₸";
}
export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");
}
export function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}
export function monthStart(s: string): string {
  return s.slice(0, 7) + "-01";
}
export function monthLabel(s: string): string {
  const names = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const [y, m] = s.split("-").map(Number);
  return `${names[m - 1]} ${String(y).slice(2)}`;
}
export function daysBetween(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
}
export function todayYmd(): string {
  return ymd(new Date());
}
export function monthsInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const d = parseYmd(monthStart(start));
  const last = parseYmd(monthStart(end));
  while (d <= last) {
    out.push(ymd(d));
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

// ── Период ─────────────────────────────────────────────────────────────────
export type PeriodPreset = "month" | "prev_month" | "quarter" | "prev_quarter" | "year" | "custom";
export const PERIOD_LABELS: { key: PeriodPreset; label: string }[] = [
  { key: "month", label: "Этот месяц" },
  { key: "prev_month", label: "Прошлый месяц" },
  { key: "quarter", label: "Квартал" },
  { key: "prev_quarter", label: "Прошлый квартал" },
  { key: "year", label: "Год" },
  { key: "custom", label: "Свой период" },
];

export function periodRange(preset: PeriodPreset, customFrom: string, customTo: string): { start: string; end: string } {
  const now = new Date();
  if (preset === "month") {
    return { start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), end: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  }
  if (preset === "prev_month") {
    return { start: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), end: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  }
  if (preset === "quarter") {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return { start: ymd(new Date(now.getFullYear(), q, 1)), end: ymd(new Date(now.getFullYear(), q + 3, 0)) };
  }
  if (preset === "prev_quarter") {
    const q = Math.floor(now.getMonth() / 3) * 3 - 3; // может уйти в прошлый год — Date это учтёт
    return { start: ymd(new Date(now.getFullYear(), q, 1)), end: ymd(new Date(now.getFullYear(), q + 3, 0)) };
  }
  if (preset === "year") {
    return { start: ymd(new Date(now.getFullYear(), 0, 1)), end: ymd(new Date(now.getFullYear(), 11, 31)) };
  }
  const from = customFrom || ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = customTo || ymd(now);
  return from <= to ? { start: from, end: to } : { start: to, end: from };
}

export function usePeriod(initial: PeriodPreset = "month") {
  const [preset, setPreset] = useState<PeriodPreset>(initial);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const range = periodRange(preset, from, to);
  return { preset, setPreset, from, setFrom, to, setTo, range };
}

// ── Выборка постранично (лимит PostgREST — 1000 строк) ─────────────────────
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// ── Справочники ────────────────────────────────────────────────────────────
export function useFinanceRef() {
  const [accounts, setAccounts] = useState<FinAccount[]>([]);
  const [categories, setCategories] = useState<FinCategory[]>([]);
  const [partners, setPartners] = useState<FinPartner[]>([]);
  const [suppliers, setSuppliers] = useState<FinSupplier[]>([]);
  const [settings, setSettings] = useState<FinSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, c, p, s, st] = await Promise.all([
        supabase.from("fin_accounts").select("*").order("sort").order("id"),
        supabase.from("fin_categories").select("*").order("sort").order("id"),
        supabase.from("fin_partners").select("*").order("name"),
        supabase.from("fin_suppliers").select("*").order("name"),
        supabase.from("fin_settings").select("key, value"),
      ]);
      for (const r of [a, c, p, s, st]) if (r.error) throw new Error(r.error.message);
      setAccounts(((a.data ?? []) as FinAccount[]).map((x) => ({ ...x, opening_balance: Number(x.opening_balance) })));
      setCategories((c.data ?? []) as FinCategory[]);
      setPartners((p.data ?? []) as FinPartner[]);
      setSuppliers((s.data ?? []) as FinSupplier[]);
      const merged: FinSettings = { ...DEFAULT_SETTINGS };
      for (const row of (st.data ?? []) as { key: string; value: unknown }[]) {
        if (row.key in merged) (merged as Record<string, unknown>)[row.key] = row.value;
      }
      setSettings(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить справочники");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { accounts, categories, partners, suppliers, settings, loading, error, reload };
}

// Статьи, которые считаются автоматически (налог с безналичных поступлений,
// себестоимость из МойСклад), в формах операций не предлагаем — иначе дважды.
export function isAutoCategory(c: FinCategory, settings: FinSettings): boolean {
  return (settings.auto_tax && c.auto_tax) || (settings.auto_cogs && c.opiu_group === "cogs");
}

export function categoryPath(categories: FinCategory[], id: number | null): string {
  if (id === null) return "Без статьи";
  const cat = categories.find((c) => c.id === id);
  if (!cat) return "—";
  if (cat.parent_id === null) return cat.name;
  const parent = categories.find((c) => c.id === cat.parent_id);
  return parent ? `${parent.name} → ${cat.name}` : cat.name;
}

// ── Остатки счетов ─────────────────────────────────────────────────────────
// Остаток = начальный остаток + операции с даты начального остатка по «на дату».
export function accountBalance(account: FinAccount, ops: FinOperation[], asOf: string): number {
  let bal = account.opening_balance;
  for (const op of ops) {
    if (op.op_date < account.opening_date || op.op_date > asOf) continue;
    if (op.kind === "income" && op.account_id === account.id) bal += op.amount;
    else if (op.kind === "expense" && op.account_id === account.id) bal -= op.amount;
    else if (op.kind === "transfer") {
      if (op.account_id === account.id) bal -= op.amount;
      if (op.to_account_id === account.id) bal += op.amount;
    }
  }
  return bal;
}

export async function loadAllOperations(): Promise<FinOperation[]> {
  const rows = await fetchAll<FinOperation>((from, to) =>
    supabase.from("fin_operations").select("*").order("op_date").order("id").range(from, to)
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

// ── ОПИУ ───────────────────────────────────────────────────────────────────
export type SalesDay = { sale_date: string; revenue: number; cost: number | null; store: string | null };
export type PnlPlanRow = { plan_month: string; category_id: number; store: string | null; amount: number };
export type SalesPlanRow = { store: string; plan_month: string; sales_plan: number | null };

export type PnlRow = {
  key: string;
  label: string;
  level: number;
  type: "line" | "subtotal" | "total";
  fact: number;
  plan: number;
  goodWhenHigh: boolean;
  // знаменатель для «% от выручки»; по умолчанию — выручка периода
  // (у себестоимости по категории товара — выручка этой же категории)
  base?: number;
  note?: string;
  categoryId?: number;
  children?: PnlRow[];
};

export type PnlResult = {
  rows: PnlRow[];
  expenses: { fact: number; plan: number }; // все расходные статьи вместе
  uncategorized: number; // операции без статьи (не вошли в ОПИУ)
  costMissing: boolean;
};

// Продажи по категориям товара (верхняя папка МойСклад) за месяц.
export type CatSalesRow = { month: string; category: string; revenue: number; cost: number };

const CATEGORY_ORDER = ["Плечевой", "Верхний", "Брюки", "Обувь", "Аксессуары", "Бесплатно", "Заморозка"];
function categoryRank(name: string): number {
  if (name === "Без категории") return 99;
  const i = CATEGORY_ORDER.indexOf(name);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// Названия папок в МойСклад → как они названы в ОПИУ владельца.
const CATEGORY_ALIAS: Record<string, string> = { Плечевая: "Плечевой", Верхняя: "Верхний", Бесплатный: "Бесплатно" };

function overlapFraction(month: string, start: string, end: string): number {
  const mStart = parseYmd(month);
  const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
  const s = parseYmd(start) > mStart ? parseYmd(start) : mStart;
  const e = parseYmd(end) < mEnd ? parseYmd(end) : mEnd;
  if (e < s) return 0;
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  return days / mEnd.getDate();
}

export function computePnl(input: {
  start: string;
  end: string;
  isAllStores: boolean;
  selectedStores: string[];
  settings: FinSettings;
  categories: FinCategory[];
  accounts: FinAccount[];
  operations: FinOperation[];
  sales: SalesDay[];
  catSales: CatSalesRow[];
  plan: PnlPlanRow[];
  salesPlan: SalesPlanRow[];
}): PnlResult {
  const { start, end, isAllStores, selectedStores, settings, categories, accounts, operations, sales, catSales, plan, salesPlan } = input;
  const storeOk = (store: string | null) => (isAllStores ? true : store !== null && selectedStores.includes(store));

  // факт по статьям из операций
  const factByCat = new Map<number, number>();
  let uncategorized = 0;
  for (const op of operations) {
    if (op.kind === "transfer" || op.op_date < start || op.op_date > end) continue;
    if (!storeOk(op.store)) continue;
    if (op.category_id === null) {
      uncategorized += 1;
      continue;
    }
    factByCat.set(op.category_id, (factByCat.get(op.category_id) ?? 0) + op.amount);
  }

  // Автоналог: процент от безналичных поступлений выручки (счета вида банк/карта).
  // Наличные не считаются. Ручные операции по такой статье не учитываем — иначе дважды.
  if (settings.auto_tax) {
    const catById = new Map(categories.map((c) => [c.id, c]));
    const accById = new Map(accounts.map((a) => [a.id, a]));
    let base = 0;
    for (const op of operations) {
      if (op.kind !== "income" || op.op_date < start || op.op_date > end || !storeOk(op.store)) continue;
      if (op.category_id === null || catById.get(op.category_id)?.opiu_group !== "revenue") continue;
      const kind = accById.get(op.account_id)?.kind;
      if (kind === "bank" || kind === "card") base += op.amount;
    }
    for (const c of categories) if (c.auto_tax) factByCat.set(c.id, (base * settings.tax_rate) / 100);
  }

  // План — «на дату»: по неоконченному периоду берём часть плана до сегодняшнего дня,
  // иначе факт за несколько дней сравнивался бы с планом на весь квартал/месяц.
  const today = todayYmd();
  const planEnd = start <= today && end > today ? today : end;

  // план по статьям (пропорционально числу дней месяца, попавших в период)
  const planByCat = new Map<number, number>();
  for (const p of plan) {
    if (!(isAllStores ? true : p.store !== null && selectedStores.includes(p.store))) continue;
    const frac = overlapFraction(p.plan_month, start, planEnd);
    if (frac <= 0) continue;
    planByCat.set(p.category_id, (planByCat.get(p.category_id) ?? 0) + Number(p.amount) * frac);
  }

  // продажи из МойСклад
  let salesRevenue = 0;
  let salesCost = 0;
  let costMissing = false;
  for (const s of sales) {
    if (s.sale_date < start || s.sale_date > end) continue;
    if (s.store && !isAllStores && !selectedStores.includes(s.store)) continue;
    salesRevenue += Number(s.revenue ?? 0);
    if (s.cost === null) costMissing = true;
    else salesCost += Number(s.cost);
  }
  // план продаж из раздела «Продажа» — запасной вариант для выручки
  let salesPlanSum = 0;
  for (const p of salesPlan) {
    if (!isAllStores && !selectedStores.includes(p.store)) continue;
    salesPlanSum += Number(p.sales_plan ?? 0) * overlapFraction(p.plan_month, start, planEnd);
  }

  // выручка и себестоимость по категориям товара
  const mFrom = monthStart(start);
  const catAgg = new Map<string, { revenue: number; cost: number }>();
  for (const r of catSales) {
    if (r.month < mFrom || r.month > end) continue;
    const a = catAgg.get(r.category) ?? { revenue: 0, cost: 0 };
    a.revenue += Number(r.revenue);
    a.cost += Number(r.cost);
    catAgg.set(r.category, a);
  }
  const catNames = [...catAgg.keys()].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b, "ru"));
  const catRevenueSum = [...catAgg.values()].reduce((a, v) => a + v.revenue, 0);
  const catCostSum = [...catAgg.values()].reduce((a, v) => a + v.cost, 0);

  // Доходная статья внутри расходного показателя (например, возврат комиссии банка) уменьшает его.
  const sign = (c: FinCategory) => (c.kind === "income" && c.opiu_group !== "revenue" && c.opiu_group !== "other_income" ? -1 : 1);

  function groupLines(goodWhenHigh: boolean, parents: FinCategory[]): PnlRow[] {
    const rows: PnlRow[] = [];
    for (const parent of parents) {
      const kids = categories.filter((c) => c.parent_id === parent.id);
      const children: PnlRow[] = [];
      const own = (factByCat.get(parent.id) ?? 0) * sign(parent);
      const ownPlan = (planByCat.get(parent.id) ?? 0) * sign(parent);
      let fact = own;
      let planSum = ownPlan;
      for (const k of kids) {
        const kf = (factByCat.get(k.id) ?? 0) * sign(k);
        const kp = (planByCat.get(k.id) ?? 0) * sign(k);
        fact += kf;
        planSum += kp;
        if (kf !== 0 || kp !== 0 || k.active) {
          children.push({ key: `c${k.id}`, label: k.name, level: 1, type: "line", fact: kf, plan: kp, goodWhenHigh, categoryId: k.id });
        }
      }
      if (children.length > 0 && (own !== 0 || ownPlan !== 0)) {
        children.unshift({ key: `c${parent.id}o`, label: "Без подпункта", level: 1, type: "line", fact: own, plan: ownPlan, goodWhenHigh, categoryId: parent.id });
      }
      if (fact === 0 && planSum === 0 && !parent.active) continue; // скрытые пустые статьи не показываем
      rows.push({
        key: `c${parent.id}`,
        label: parent.name,
        level: 0,
        type: children.length > 0 ? "subtotal" : "line",
        fact,
        plan: planSum,
        goodWhenHigh,
        categoryId: parent.id,
        children,
      });
    }
    return rows;
  }
  const topOf = (group: OpiuGroup) => categories.filter((c) => c.parent_id === null && c.opiu_group === group);
  const sum = (rows: PnlRow[], f: "fact" | "plan") => rows.reduce((a, r) => a + r[f], 0);

  const out: PnlRow[] = [];

  // Выручка
  const revManual = groupLines(true, topOf("revenue"));
  const revPlanManual = sum(revManual, "plan");
  let revenue: PnlRow;
  if (settings.auto_revenue) {
    const kids: PnlRow[] = catNames.map((n) => ({ key: `rev-${n}`, label: n, level: 1, type: "line", fact: catAgg.get(n)!.revenue, plan: 0, goodWhenHigh: true }));
    const diff = salesRevenue - catRevenueSum;
    if (kids.length > 0 && Math.abs(diff) > 1) kids.push({ key: "rev-rest", label: "Прочее", level: 1, type: "line", fact: diff, plan: 0, goodWhenHigh: true });
    revenue = {
      key: "h-rev",
      label: "Оборот",
      level: 0,
      type: "subtotal",
      fact: salesRevenue,
      plan: revPlanManual > 0 ? revPlanManual : salesPlanSum,
      goodWhenHigh: true,
      note: revPlanManual > 0 || salesPlanSum === 0 ? undefined : "план — из раздела «Продажа»",
      children: kids,
    };
  } else {
    revenue = { key: "h-rev", label: "Оборот", level: 0, type: "subtotal", fact: sum(revManual, "fact"), plan: revPlanManual, goodWhenHigh: true, children: revManual };
  }
  out.push(revenue);

  // Себестоимость
  const cogsManual = groupLines(false, topOf("cogs"));
  let cogs: PnlRow;
  if (settings.auto_cogs) {
    const kids: PnlRow[] = catNames.map((n) => ({
      key: `cogs-${n}`,
      label: n,
      level: 1,
      type: "line",
      fact: catAgg.get(n)!.cost,
      plan: 0,
      goodWhenHigh: false,
      base: catAgg.get(n)!.revenue,
    }));
    const diff = salesCost - catCostSum;
    if (kids.length > 0 && Math.abs(diff) > 1) kids.push({ key: "cogs-rest", label: "Прочее", level: 1, type: "line", fact: diff, plan: 0, goodWhenHigh: false });
    cogs = {
      key: "h-cogs",
      label: "Себестоимость",
      level: 0,
      type: "subtotal",
      fact: salesCost,
      plan: sum(cogsManual, "plan"),
      goodWhenHigh: false,
      note: costMissing ? "в части дней себестоимость не загружена" : undefined,
      children: kids,
    };
  } else {
    cogs = { key: "h-cogs", label: "Себестоимость", level: 0, type: "subtotal", fact: sum(cogsManual, "fact"), plan: sum(cogsManual, "plan"), goodWhenHigh: false, children: cogsManual };
  }
  out.push(cogs);

  const gross: PnlRow = { key: "gross", label: "Валовая прибыль", level: 0, type: "total", fact: revenue.fact - cogs.fact, plan: revenue.plan - cogs.plan, goodWhenHigh: true };
  out.push(gross);

  // Расходные показатели — всегда в порядке владельца, даже если по ним пока ноль
  const indicatorRows: PnlRow[] = EXPENSE_INDICATORS.map((group) => {
    const topRows = groupLines(false, topOf(group));
    // одна статья без подпунктов — детализация не нужна; одна статья с подпунктами — показываем подпункты
    const only = topRows.length === 1 ? topRows[0] : null;
    const children = only
      ? (only.children ?? []).map((c) => ({ ...c, label: only.label === OPIU_GROUP_LABEL[group] ? c.label : `${only.label} - ${c.label}` }))
      : topRows;
    return {
      key: `i-${group}`,
      label: OPIU_GROUP_LABEL[group],
      level: 0,
      type: children.length > 0 ? "subtotal" : "line",
      fact: sum(topRows, "fact"),
      plan: sum(topRows, "plan"),
      goodWhenHigh: false,
      children,
    } as PnlRow;
  });
  for (const r of indicatorRows) out.push(r);

  // Прочие доходы/расходы показываем, только если по ним что-то есть
  const extra = (group: "other_income" | "other_expense"): PnlRow | null => {
    const topRows = groupLines(group === "other_income", topOf(group));
    const fact = sum(topRows, "fact");
    const planSum = sum(topRows, "plan");
    if (fact === 0 && planSum === 0) return null;
    return { key: `i-${group}`, label: OPIU_GROUP_LABEL[group], level: 0, type: topRows.length > 0 ? "subtotal" : "line", fact, plan: planSum, goodWhenHigh: group === "other_income", children: topRows };
  };
  const oi = extra("other_income");
  const oe = extra("other_expense");
  if (oi) out.push(oi);
  if (oe) out.push(oe);

  const expenses = { fact: sum(indicatorRows, "fact") + (oe?.fact ?? 0), plan: sum(indicatorRows, "plan") + (oe?.plan ?? 0) };

  out.push({
    key: "net",
    label: "Рентабельность",
    level: 0,
    type: "total",
    fact: gross.fact + (oi?.fact ?? 0) - expenses.fact,
    plan: gross.plan + (oi?.plan ?? 0) - expenses.plan,
    goodWhenHigh: true,
  });

  return { rows: out, expenses, uncategorized, costMissing };
}

export async function loadCatSales(start: string, end: string, cities: string[] | null): Promise<CatSalesRow[]> {
  const { data, error } = await supabase.rpc("finance_sales_by_category", { p_from: start, p_to: end, p_cities: cities });
  if (error) return []; // нет доступа или функция недоступна — разбивка по категориям просто не показывается
  return ((data ?? []) as { month: string; category: string; revenue: number; cost: number }[]).map((r) => ({
    month: r.month,
    category: CATEGORY_ALIAS[r.category] ?? r.category,
    revenue: Number(r.revenue ?? 0),
    cost: Number(r.cost ?? 0),
  }));
}

export async function loadSales(start: string, end: string): Promise<SalesDay[]> {
  type Raw = { sale_date: string; revenue: number; cost: number | null; moysklad_registers: { store: string | null } | null };
  const rows = await fetchAll<Raw>((from, to) =>
    supabase
      .from("moysklad_sales_daily")
      .select("sale_date, revenue, cost, moysklad_registers(store)")
      .gte("sale_date", start)
      .lte("sale_date", end)
      .range(from, to)
  );
  return rows.map((r) => ({ sale_date: r.sale_date, revenue: Number(r.revenue), cost: r.cost === null ? null : Number(r.cost), store: r.moysklad_registers?.store ?? null }));
}

export async function loadPnlInputs(start: string, end: string, cities: string[] | null) {
  const months = monthsInRange(start, end);
  const [sales, catSales, plan, salesPlan, ops] = await Promise.all([
    loadSales(start, end),
    loadCatSales(start, end, cities),
    supabase.from("fin_pnl_plan").select("plan_month, category_id, store, amount").in("plan_month", months),
    supabase.from("sales_plan_monthly").select("store, plan_month, sales_plan").in("plan_month", months),
    fetchAll<FinOperation>((from, to) =>
      supabase.from("fin_operations").select("*").gte("op_date", start).lte("op_date", end).neq("kind", "transfer").range(from, to)
    ),
  ]);
  // план ОПИУ и план продаж видны не всем — без доступа просто пусто
  return {
    sales,
    catSales,
    plan: ((plan.error ? [] : (plan.data ?? [])) as PnlPlanRow[]).map((p) => ({ ...p, amount: Number(p.amount) })),
    salesPlan: (salesPlan.error ? [] : (salesPlan.data ?? [])) as SalesPlanRow[],
    operations: ops.map((o) => ({ ...o, amount: Number(o.amount) })),
  };
}

// ── Долги ──────────────────────────────────────────────────────────────────
export type FinDebt = {
  id: number;
  kind: "store_store" | "supplier";
  direction: "payable" | "receivable";
  store: string;
  counterparty_store: string | null;
  supplier_id: number | null;
  amount: number;
  debt_date: string;
  due_date: string | null;
  comment: string | null;
  closed: boolean;
  doc_number: string | null;
  operation_id: number | null;
  unlock_expires_at: string | null;
};
export type FinDebtPayment = {
  id: number;
  debt_id: number;
  pay_date: string;
  amount: number;
  operation_id: number | null;
  comment: string | null;
};

export async function loadDebts(): Promise<{ debts: FinDebt[]; payments: FinDebtPayment[] }> {
  const [d, p] = await Promise.all([
    supabase.from("fin_debts").select("*").order("debt_date", { ascending: false }),
    supabase.from("fin_debt_payments").select("*").order("pay_date"),
  ]);
  if (d.error) throw new Error(d.error.message);
  if (p.error) throw new Error(p.error.message);
  return {
    debts: ((d.data ?? []) as FinDebt[]).map((x) => ({ ...x, amount: Number(x.amount) })),
    payments: ((p.data ?? []) as FinDebtPayment[]).map((x) => ({ ...x, amount: Number(x.amount) })),
  };
}

// Чей это долг относительно выбранных магазинов: payable — мы должны,
// receivable — нам должны, null — не считаем (расчёты между своими магазинами
// при выборе «все магазины» или когда оба магазина выбраны).
export function debtDirection(d: FinDebt, isAll: boolean, selected: string[]): "payable" | "receivable" | null {
  if (d.kind !== "store_store") return d.direction;
  if (isAll) return null;
  const debtorIn = selected.includes(d.store);
  const creditorIn = d.counterparty_store !== null && selected.includes(d.counterparty_store);
  if (debtorIn && !creditorIn) return "payable";
  if (creditorIn && !debtorIn) return "receivable";
  return null;
}

export function debtRemaining(debt: FinDebt, payments: FinDebtPayment[]): number {
  const paid = payments.filter((p) => p.debt_id === debt.id).reduce((a, p) => a + p.amount, 0);
  return Math.max(0, debt.amount - paid);
}

// ── Плановые платежи ───────────────────────────────────────────────────────
export type FinPlanned = {
  id: number;
  due_date: string;
  kind: "income" | "expense";
  amount: number;
  category_id: number | null;
  store: string | null;
  supplier_id: number | null;
  account_id: number | null;
  repeat: "none" | "weekly" | "monthly";
  status: "planned" | "paid" | "cancelled";
  operation_id: number | null;
  comment: string | null;
};

export async function loadPlanned(): Promise<FinPlanned[]> {
  const { data, error } = await supabase.from("fin_planned_payments").select("*").order("due_date");
  if (error) throw new Error(error.message);
  return ((data ?? []) as FinPlanned[]).map((x) => ({ ...x, amount: Number(x.amount) }));
}

export function nextDueDate(due: string, repeat: "none" | "weekly" | "monthly"): string | null {
  if (repeat === "none") return null;
  if (repeat === "weekly") return addDays(due, 7);
  const d = parseYmd(due);
  const day = d.getDate();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return ymd(next);
}

// ── Правка по запросу ──────────────────────────────────────────────────────
// Изменить или удалить операцию/долг можно, только пока открыто окно после
// одобрения запроса (раздел «Запросы»).
export function isUnlocked(row: { unlock_expires_at: string | null }): boolean {
  return !!row.unlock_expires_at && new Date(row.unlock_expires_at) > new Date();
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// Номера строк, по которым уже есть запрос в ожидании (видны свои; админу — все).
export async function loadPendingRequestIds(table: "fin_operations" | "fin_debts"): Promise<Set<number>> {
  const { data, error } = await supabase.from("edit_requests").select("row_id").eq("table_name", table).eq("status", "pending");
  if (error) return new Set();
  return new Set(((data ?? []) as { row_id: number | null }[]).map((r) => r.row_id).filter((x): x is number => x !== null));
}

export async function createChangeRequest(input: { table: "fin_operations" | "fin_debts"; rowId: number; store: string | null; context: string }): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return "Нет активной сессии.";
  const { error } = await supabase.from("edit_requests").insert({
    table_name: input.table,
    row_id: input.rowId,
    store: input.store,
    context: input.context,
    requested_by: uid,
  });
  return error ? error.message : null;
}

// Запись в «Историю» о правке или удалении.
export async function logChange(input: { table: "fin_operations" | "fin_debts"; rowId: number; store: string | null; summary: string; byName: string }) {
  const { data: userData } = await supabase.auth.getUser();
  await supabase.from("edit_history").insert({
    table_name: input.table,
    row_id: input.rowId,
    store: input.store,
    summary: input.summary,
    changed_by: userData.user?.id ?? null,
    changed_by_name: input.byName,
  });
}

export function findCategory(categories: FinCategory[], name: string, parentName?: string): FinCategory | undefined {
  if (parentName) {
    const parent = categories.find((c) => c.parent_id === null && c.name === parentName);
    return parent ? categories.find((c) => c.parent_id === parent.id && c.name === name) : undefined;
  }
  return categories.find((c) => c.parent_id === null && c.name === name);
}
