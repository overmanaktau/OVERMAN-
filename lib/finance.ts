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
export type OpiuGroup = "revenue" | "cogs" | "opex" | "other_income" | "other_expense" | "tax";
export type FinCategory = {
  id: number;
  parent_id: number | null;
  name: string;
  kind: "income" | "expense";
  opiu_group: OpiuGroup | null;
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
  partner_id: number | null;
  debt_id: number | null;
  comment: string | null;
};

export const ACCOUNT_KIND_LABEL: Record<FinAccount["kind"], string> = {
  cash: "Наличные (касса)",
  bank: "Расчётный счёт",
  card: "Карта",
  other: "Другое",
};

export const OPIU_GROUP_LABEL: Record<OpiuGroup, string> = {
  revenue: "Выручка",
  cogs: "Себестоимость",
  opex: "Операционные расходы",
  other_income: "Прочие доходы",
  other_expense: "Прочие расходы",
  tax: "Налоги",
};

const DEFAULT_SETTINGS: FinSettings = { auto_revenue: true, auto_cogs: true, debt_alert_days: 7, low_balance_limit: 0 };

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
export type PeriodPreset = "month" | "prev_month" | "quarter" | "year" | "custom";
export const PERIOD_LABELS: { key: PeriodPreset; label: string }[] = [
  { key: "month", label: "Этот месяц" },
  { key: "prev_month", label: "Прошлый месяц" },
  { key: "quarter", label: "Квартал" },
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

// Статьи выручки/себестоимости, которые считаются из МойСклад автоматически,
// в формах операций не предлагаем — иначе деньги посчитались бы дважды.
export function isAutoCategory(c: FinCategory, settings: FinSettings): boolean {
  return (settings.auto_revenue && c.opiu_group === "revenue") || (settings.auto_cogs && c.opiu_group === "cogs");
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
  level: 0 | 1;
  type: "line" | "subtotal" | "total";
  fact: number;
  plan: number;
  goodWhenHigh: boolean;
  note?: string;
  categoryId?: number;
  children?: PnlRow[];
};

export type PnlResult = {
  rows: PnlRow[];
  uncategorized: number; // операции без статьи (не вошли в ОПИУ)
  costMissing: boolean;
};

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
  operations: FinOperation[];
  sales: SalesDay[];
  plan: PnlPlanRow[];
  salesPlan: SalesPlanRow[];
}): PnlResult {
  const { start, end, isAllStores, selectedStores, settings, categories, operations, sales, plan, salesPlan } = input;
  const catById = new Map(categories.map((c) => [c.id, c]));
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

  // план по статьям (пропорционально числу дней месяца, попавших в период)
  const planByCat = new Map<number, number>();
  for (const p of plan) {
    if (!(isAllStores ? true : p.store !== null && selectedStores.includes(p.store))) continue;
    const frac = overlapFraction(p.plan_month, start, end);
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
    salesPlanSum += Number(p.sales_plan ?? 0) * overlapFraction(p.plan_month, start, end);
  }

  const top = (group: OpiuGroup) =>
    categories.filter((c) => c.parent_id === null && c.opiu_group === group && (c.active || (factByCat.get(c.id) ?? 0) > 0));

  function buildGroup(group: OpiuGroup, goodWhenHigh: boolean): PnlRow[] {
    const rows: PnlRow[] = [];
    for (const parent of top(group)) {
      const kids = categories.filter((c) => c.parent_id === parent.id);
      const children: PnlRow[] = [];
      let fact = factByCat.get(parent.id) ?? 0;
      let planSum = planByCat.get(parent.id) ?? 0;
      for (const k of kids) {
        const kf = factByCat.get(k.id) ?? 0;
        const kp = planByCat.get(k.id) ?? 0;
        fact += kf;
        planSum += kp;
        if (kf !== 0 || kp !== 0) {
          children.push({ key: `c${k.id}`, label: k.name, level: 1, type: "line", fact: kf, plan: kp, goodWhenHigh, categoryId: k.id });
        }
      }
      const own = factByCat.get(parent.id) ?? 0;
      const ownPlan = planByCat.get(parent.id) ?? 0;
      if (children.length > 0 && (own !== 0 || ownPlan !== 0)) {
        children.unshift({ key: `c${parent.id}o`, label: "Без подпункта", level: 1, type: "line", fact: own, plan: ownPlan, goodWhenHigh, categoryId: parent.id });
      }
      if (fact === 0 && planSum === 0) continue; // пустые статьи в отчёте не показываем
      rows.push({ key: `c${parent.id}`, label: parent.name, level: 0, type: "line", fact, plan: planSum, goodWhenHigh, categoryId: parent.id, children });
    }
    return rows;
  }
  const sum = (rows: PnlRow[], f: "fact" | "plan") => rows.reduce((a, r) => a + r[f], 0);

  const out: PnlRow[] = [];

  // Выручка
  let revenueRows: PnlRow[];
  if (settings.auto_revenue) {
    const planned = sum(buildGroup("revenue", true), "plan");
    revenueRows = [
      {
        key: "rev-ms",
        label: "Выручка от продаж (МойСклад)",
        level: 0,
        type: "line",
        fact: salesRevenue,
        plan: planned > 0 ? planned : salesPlanSum,
        goodWhenHigh: true,
        note: planned > 0 ? undefined : "план — из раздела «Продажа»",
      },
    ];
  } else {
    revenueRows = buildGroup("revenue", true);
  }
  out.push({ key: "h-rev", label: "Выручка", level: 0, type: "subtotal", fact: sum(revenueRows, "fact"), plan: sum(revenueRows, "plan"), goodWhenHigh: true, children: revenueRows });
  const revenue = out[out.length - 1];

  // Себестоимость
  let cogsRows: PnlRow[];
  if (settings.auto_cogs) {
    const planned = sum(buildGroup("cogs", false), "plan");
    cogsRows = [
      { key: "cogs-ms", label: "Себестоимость проданного (МойСклад)", level: 0, type: "line", fact: salesCost, plan: planned, goodWhenHigh: false, note: costMissing ? "в части дней себестоимость не загружена" : undefined },
    ];
  } else {
    cogsRows = buildGroup("cogs", false);
  }
  const cogs: PnlRow = { key: "h-cogs", label: "Себестоимость", level: 0, type: "subtotal", fact: sum(cogsRows, "fact"), plan: sum(cogsRows, "plan"), goodWhenHigh: false, children: cogsRows };
  out.push(cogs);

  const gross: PnlRow = { key: "gross", label: "Валовая прибыль", level: 0, type: "total", fact: revenue.fact - cogs.fact, plan: revenue.plan - cogs.plan, goodWhenHigh: true };
  out.push(gross);

  const opexRows = buildGroup("opex", false);
  const opex: PnlRow = { key: "h-opex", label: "Операционные расходы", level: 0, type: "subtotal", fact: sum(opexRows, "fact"), plan: sum(opexRows, "plan"), goodWhenHigh: false, children: opexRows };
  out.push(opex);

  const operating: PnlRow = { key: "operating", label: "Операционная прибыль", level: 0, type: "total", fact: gross.fact - opex.fact, plan: gross.plan - opex.plan, goodWhenHigh: true };
  out.push(operating);

  const oiRows = buildGroup("other_income", true);
  const oeRows = buildGroup("other_expense", false);
  const taxRows = buildGroup("tax", false);
  const oi: PnlRow = { key: "h-oi", label: "Прочие доходы", level: 0, type: "subtotal", fact: sum(oiRows, "fact"), plan: sum(oiRows, "plan"), goodWhenHigh: true, children: oiRows };
  const oe: PnlRow = { key: "h-oe", label: "Прочие расходы", level: 0, type: "subtotal", fact: sum(oeRows, "fact"), plan: sum(oeRows, "plan"), goodWhenHigh: false, children: oeRows };
  const tax: PnlRow = { key: "h-tax", label: "Налоги", level: 0, type: "subtotal", fact: sum(taxRows, "fact"), plan: sum(taxRows, "plan"), goodWhenHigh: false, children: taxRows };
  out.push(oi, oe, tax);

  out.push({
    key: "net",
    label: "Чистая прибыль",
    level: 0,
    type: "total",
    fact: operating.fact + oi.fact - oe.fact - tax.fact,
    plan: operating.plan + oi.plan - oe.plan - tax.plan,
    goodWhenHigh: true,
  });

  return { rows: out, uncategorized, costMissing };
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

export async function loadPnlInputs(start: string, end: string) {
  const months = monthsInRange(start, end);
  const [sales, plan, salesPlan, ops] = await Promise.all([
    loadSales(start, end),
    supabase.from("fin_pnl_plan").select("plan_month, category_id, store, amount").in("plan_month", months),
    supabase.from("sales_plan_monthly").select("store, plan_month, sales_plan").in("plan_month", months),
    fetchAll<FinOperation>((from, to) =>
      supabase.from("fin_operations").select("*").gte("op_date", start).lte("op_date", end).neq("kind", "transfer").range(from, to)
    ),
  ]);
  // план ОПИУ и план продаж видны не всем — без доступа просто пусто
  return {
    sales,
    plan: ((plan.error ? [] : (plan.data ?? [])) as PnlPlanRow[]).map((p) => ({ ...p, amount: Number(p.amount) })),
    salesPlan: (salesPlan.error ? [] : (salesPlan.data ?? [])) as SalesPlanRow[],
    operations: ops.map((o) => ({ ...o, amount: Number(o.amount) })),
  };
}

// ── Долги ──────────────────────────────────────────────────────────────────
export type FinDebt = {
  id: number;
  kind: "store_store" | "supplier" | "partner";
  direction: "payable" | "receivable";
  store: string;
  counterparty_store: string | null;
  supplier_id: number | null;
  partner_id: number | null;
  amount: number;
  debt_date: string;
  due_date: string | null;
  comment: string | null;
  closed: boolean;
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
  partner_id: number | null;
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
