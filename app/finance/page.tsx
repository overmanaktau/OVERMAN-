"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import KpiCard from "@/components/KpiCard";
import {
  accountBalance,
  addDays,
  categoryPath,
  computePnl,
  daysBetween,
  debtDirection,
  debtRemaining,
  fmtDate,
  fmtMoney,
  fmtPct,
  loadAllOperations,
  loadDebts,
  loadPlanned,
  loadPnlInputs,
  todayYmd,
  useFinanceRef,
  usePeriod,
  type FinDebt,
  type FinDebtPayment,
  type FinOperation,
  type FinPlanned,
  type PnlResult,
} from "@/lib/finance";
import { Card, Chip, Empty, ErrorBox, FinanceGuard, PageTitle, PeriodTabs } from "@/components/finance/ui";

export default function FinanceOverviewPage() {
  return (
    <FinanceGuard section="finance.overview">
      <Inner />
    </FinanceGuard>
  );
}

function Inner() {
  const ref = useFinanceRef();
  const { stores } = useAuth();
  const { selected, isAll } = useStoreSelection();
  const period = usePeriod("month");
  const { start, end } = period.range;
  const today = todayYmd();

  const [ops, setOps] = useState<FinOperation[]>([]);
  const [debts, setDebts] = useState<FinDebt[]>([]);
  const [payments, setPayments] = useState<FinDebtPayment[]>([]);
  const [planned, setPlanned] = useState<FinPlanned[]>([]);
  const [pnl, setPnl] = useState<PnlResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ref.loading) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [o, d, p, inputs] = await Promise.all([
          loadAllOperations().catch(() => [] as FinOperation[]),
          loadDebts().catch(() => ({ debts: [] as FinDebt[], payments: [] as FinDebtPayment[] })),
          loadPlanned().catch(() => [] as FinPlanned[]),
          loadPnlInputs(start, end, isAll ? null : selected),
        ]);
        if (cancelled) return;
        setOps(o);
        setDebts(d.debts);
        setPayments(d.payments);
        setPlanned(p);
        setPnl(computePnl({ start, end, isAllStores: isAll, selectedStores: selected, settings: ref.settings, categories: ref.categories, ...inputs }));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Не удалось загрузить данные");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [ref.loading, ref.settings, ref.categories, start, end, isAll, selected]);

  const accounts = useMemo(() => ref.accounts.filter((a) => a.active && (isAll || (a.store !== null && selected.includes(a.store)))), [ref.accounts, isAll, selected]);
  const balances = accounts.map((a) => ({ a, bal: accountBalance(a, ops, today) }));
  const totalBalance = balances.reduce((s, x) => s + x.bal, 0);

  const scopedOps = ops.filter((o) => o.op_date >= start && o.op_date <= end && (isAll || (o.store !== null && selected.includes(o.store))));
  const inflow = scopedOps.filter((o) => o.kind === "income").reduce((s, o) => s + o.amount, 0);
  const outflow = scopedOps.filter((o) => o.kind === "expense").reduce((s, o) => s + o.amount, 0);

  const debtRows = debts
    .filter((d) => isAll || selected.includes(d.store) || (d.counterparty_store !== null && selected.includes(d.counterparty_store)))
    .map((d) => ({ d, rem: debtRemaining(d, payments) }))
    .filter((x) => x.rem > 0);
  const weOwe = debtRows.filter((x) => debtDirection(x.d, isAll, selected) === "payable").reduce((s, x) => s + x.rem, 0);
  const owedToUs = debtRows.filter((x) => debtDirection(x.d, isAll, selected) === "receivable").reduce((s, x) => s + x.rem, 0);

  const revenue = pnl?.rows.find((r) => r.key === "h-rev");
  const net = pnl?.rows.find((r) => r.key === "net");
  const gross = pnl?.rows.find((r) => r.key === "gross");

  // топ расходов периода по статьям (из ОПИУ: операционные, прочие, налоги)
  const topExpenses = useMemo(() => {
    const lines: { label: string; v: number }[] = [];
    for (const r of pnl?.rows ?? []) if (r.key.startsWith("c") && r.fact > 0) lines.push({ label: r.label, v: r.fact });
    return lines.sort((a, b) => b.v - a.v).slice(0, 6);
  }, [pnl]);
  const maxExpense = Math.max(1, ...topExpenses.map((x) => x.v));

  // требует внимания
  const alertDays = ref.settings.debt_alert_days;
  const attention: { tone: "bad" | "warn"; text: string; href: string }[] = [];
  if (!loading && ref.accounts.length === 0) attention.push({ tone: "warn", text: "Не заведены счета — добавьте их в «Настройки → Счета»", href: "/finance/settings" });
  for (const x of balances) {
    if (x.bal < ref.settings.low_balance_limit || x.bal < 0) attention.push({ tone: "bad", text: `Остаток на счёте «${x.a.name}»: ${fmtMoney(x.bal)}`, href: "/finance/dds" });
  }
  for (const { d, rem } of debtRows) {
    if (debtDirection(d, isAll, selected) !== "payable" || !d.due_date) continue;
    const left = daysBetween(today, d.due_date);
    const who =
      d.kind === "supplier"
        ? ref.suppliers.find((s) => s.id === d.supplier_id)?.name
        : d.kind === "partner"
          ? ref.partners.find((p) => p.id === d.partner_id)?.name
          : stores.find((s) => s.code === d.counterparty_store)?.name;
    if (left < 0) attention.push({ tone: "bad", text: `Долг «${who ?? "—"}» ${fmtMoney(rem)} просрочен на ${-left} дн.`, href: "/finance/debts" });
    else if (left <= alertDays) attention.push({ tone: "warn", text: `Долг «${who ?? "—"}» ${fmtMoney(rem)} — срок через ${left} дн.`, href: "/finance/debts" });
  }
  for (const p of planned.filter((x) => x.status === "planned" && x.kind === "expense" && (isAll || (x.store !== null && selected.includes(x.store))))) {
    const left = daysBetween(today, p.due_date);
    if (left < 0) attention.push({ tone: "bad", text: `Платёж «${categoryPath(ref.categories, p.category_id)}» ${fmtMoney(p.amount)} просрочен на ${-left} дн.`, href: "/finance/planned" });
    else if (left <= alertDays) attention.push({ tone: "warn", text: `Платёж «${categoryPath(ref.categories, p.category_id)}» ${fmtMoney(p.amount)} — ${fmtDate(p.due_date)}`, href: "/finance/planned" });
  }
  if (pnl && pnl.uncategorized > 0) attention.push({ tone: "warn", text: `Операций без статьи за период: ${pnl.uncategorized}`, href: "/finance/dds" });
  attention.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));

  const upcoming = planned
    .filter((x) => x.status === "planned" && x.due_date <= addDays(today, 14) && (isAll || (x.store !== null && selected.includes(x.store))))
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 6);

  const revPct = revenue && revenue.plan > 0 ? (revenue.fact / revenue.plan) * 100 : null;
  const margin = revenue && revenue.fact > 0 && gross ? (gross.fact / revenue.fact) * 100 : null;
  const burn = pnl?.expenses.fact ?? 0;
  const periodDays = Math.max(1, daysBetween(start, end) + 1);
  const runwayDays = burn > 0 ? Math.max(0, Math.floor(totalBalance / (burn / periodDays))) : null;

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="Финансы — обзор" subtitle="Деньги на счетах, прибыль за период, долги и ближайшие платежи на одном экране." />
      <PeriodTabs preset={period.preset} onPreset={period.setPreset} from={period.from} onFrom={period.setFrom} to={period.to} onTo={period.setTo} />
      <ErrorBox message={error ?? ref.error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Деньги на счетах сейчас" value={fmtMoney(totalBalance)} valueTone={totalBalance < 0 ? "negative" : "neutral"} note={`${accounts.length} счетов`} />
        <KpiCard label="Выручка за период" value={revenue ? fmtMoney(revenue.fact) : "—"} note={revPct === null ? "план не задан" : `${fmtPct(revPct)} от плана`} noteTone={revPct !== null && revPct >= 100 ? "positive" : "neutral"} />
        <KpiCard label="Чистая прибыль" value={net ? fmtMoney(net.fact) : "—"} valueTone={(net?.fact ?? 0) < 0 ? "negative" : "positive"} note={margin === null ? undefined : `валовая маржа ${margin.toFixed(1)}%`} />
        <KpiCard label="Поток денег за период" value={`${inflow - outflow >= 0 ? "+" : "−"}${fmtMoney(Math.abs(inflow - outflow))}`} valueTone={inflow - outflow >= 0 ? "positive" : "negative"} note={`приход ${fmtMoney(inflow)} · выплаты ${fmtMoney(outflow)}`} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Мы должны" value={fmtMoney(weOwe)} valueTone={weOwe > 0 ? "warning" : "neutral"} />
        <KpiCard label="Нам должны" value={fmtMoney(owedToUs)} valueTone="positive" />
        <KpiCard label="Расходы за период" value={fmtMoney(burn)} note={revenue && revenue.fact > 0 ? `${((burn / revenue.fact) * 100).toFixed(1)}% от выручки` : undefined} />
        <KpiCard label="Запас на расходах" value={runwayDays === null ? "—" : `${runwayDays} дн.`} note="на сколько дней хватит остатка при таких расходах" />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Card title="Требует внимания">
          {loading ? (
            <Empty>Загрузка…</Empty>
          ) : attention.length === 0 ? (
            <Empty>Всё в порядке — просрочек и тревог нет</Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {attention.slice(0, 10).map((a, i) => (
                <Link key={i} href={a.href} className="flex items-start gap-2.5 text-[13px] text-ink hover:bg-paper rounded-md px-2 py-1.5 -mx-2">
                  <Chip tone={a.tone}>{a.tone === "bad" ? "срочно" : "скоро"}</Chip>
                  <span>{a.text}</span>
                </Link>
              ))}
              {attention.length > 10 && <div className="text-[12px] text-muted">…и ещё {attention.length - 10}</div>}
            </div>
          )}
        </Card>

        <Card title="Счета" right={<Link href="/finance/dds" className="text-[12px] text-accent font-semibold">ДДС →</Link>}>
          {balances.length === 0 ? (
            <Empty>Счетов пока нет</Empty>
          ) : (
            <div className="flex flex-col">
              {balances.map(({ a, bal }) => (
                <div key={a.id} className="flex items-center justify-between py-2 border-b border-border last:border-0 text-[13px]">
                  <span className="text-ink">
                    {a.name}
                    {a.store && <span className="text-muted"> · {stores.find((s) => s.code === a.store)?.name}</span>}
                  </span>
                  <span className={`num font-semibold ${bal < 0 ? "text-[#A34B36]" : ""}`}>{fmtMoney(bal)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Куда уходят деньги" right={<Link href="/finance/opiu" className="text-[12px] text-accent font-semibold">ОПИУ →</Link>}>
          {topExpenses.length === 0 ? (
            <Empty>За период расходов нет</Empty>
          ) : (
            <div className="flex flex-col gap-3">
              {topExpenses.map((x) => (
                <div key={x.label}>
                  <div className="flex justify-between text-[13px] mb-1">
                    <span className="text-ink">{x.label}</span>
                    <span className="num text-muted">{fmtMoney(x.v)}</span>
                  </div>
                  <div className="h-2 bg-paper rounded-full overflow-hidden">
                    <div className="h-full bg-accent rounded-full" style={{ width: `${(x.v / maxExpense) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Ближайшие 14 дней" right={<Link href="/finance/planned" className="text-[12px] text-accent font-semibold">Все платежи →</Link>}>
          {upcoming.length === 0 ? (
            <Empty>Плановых платежей нет</Empty>
          ) : (
            <div className="flex flex-col">
              {upcoming.map((p) => {
                const left = daysBetween(today, p.due_date);
                return (
                  <div key={p.id} className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0 text-[13px]">
                    <span className="text-ink">
                      {fmtDate(p.due_date)} · {categoryPath(ref.categories, p.category_id)}
                      {left < 0 && (
                        <span className="ml-2">
                          <Chip tone="bad">просрочен</Chip>
                        </span>
                      )}
                    </span>
                    <span className={`num font-semibold ${p.kind === "income" ? "text-accent" : "text-[#A34B36]"}`}>
                      {p.kind === "income" ? "+" : "−"}
                      {fmtMoney(p.amount)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
