"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { downloadExcel } from "@/lib/exportExcel";
import KpiCard from "@/components/KpiCard";
import {
  computePnl,
  EXPENSE_INDICATORS,
  fmtMoney,
  fmtNum,
  fmtPct,
  loadPnlInputs,
  monthLabel,
  monthStart,
  monthsInRange,
  OPIU_GROUP_LABEL,
  todayYmd,
  useFinanceRef,
  usePeriod,
  ymd,
  parseYmd,
  type FinCategory,
  type OpiuGroup,
  type PnlResult,
  type PnlRow,
} from "@/lib/finance";
import {
  Card,
  Empty,
  ErrorBox,
  Field,
  FinanceGuard,
  Modal,
  PageTitle,
  PeriodTabs,
  Tabs,
  btnGhost,
  btnPrimary,
  inputCls,
  selectCls,
  tdCls,
  thCls,
  useSection,
} from "@/components/finance/ui";

export default function OpiuPage() {
  return (
    <FinanceGuard section="finance.opiu">
      <Inner />
    </FinanceGuard>
  );
}

type View = "months" | "planfact";
type Inputs = Awaited<ReturnType<typeof loadPnlInputs>>;

function lastDayOf(month: string): string {
  const d = parseYmd(month);
  return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

function pctText(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "";
  return `${p.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function Inner() {
  const ref = useFinanceRef();
  const { stores } = useAuth();
  const { selected, isAll } = useStoreSelection();
  const { canEdit } = useSection("finance.opiu");
  const period = usePeriod("year");
  const { start, end } = period.range;

  const [view, setView] = useState<View>("months");
  const [inputs, setInputs] = useState<Inputs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [planOpen, setPlanOpen] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await loadPnlInputs(start, end, isAll ? null : selected);
        if (!cancelled) setInputs(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Не удалось построить отчёт");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [start, end, isAll, selected, tick]);

  const calc = useCallback(
    (s: string, e: string): PnlResult | null =>
      inputs
        ? computePnl({ start: s, end: e, isAllStores: isAll, selectedStores: selected, settings: ref.settings, categories: ref.categories, accounts: ref.accounts, ...inputs })
        : null,
    [inputs, isAll, selected, ref.settings, ref.categories, ref.accounts]
  );

  const total = useMemo(() => (ref.loading ? null : calc(start, end)), [calc, start, end, ref.loading]);

  // колонки-месяцы (будущие месяцы не показываем — по ним ещё нет факта)
  const months = useMemo(() => {
    const all = monthsInRange(start, end);
    const upto = all.filter((m) => m <= monthStart(todayYmd()));
    return upto.length > 0 ? upto : all;
  }, [start, end]);

  const columns = useMemo(() => {
    if (ref.loading) return [];
    return months.map((m) => {
      const cs = m > start ? m : start;
      const ce = lastDayOf(m) < end ? lastDayOf(m) : end;
      const res = calc(cs, ce);
      const rev = res?.rows.find((r) => r.key === "h-rev")?.fact ?? 0;
      const cells = new Map<string, { fact: number; pct: number | null }>();
      const walk = (rows: PnlRow[]) => {
        for (const r of rows) {
          const base = r.base ?? rev;
          cells.set(r.key, { fact: r.fact, pct: base > 0 ? (r.fact / base) * 100 : null });
          if (r.children) walk(r.children);
        }
      };
      if (res) walk(res.rows);
      return { month: m, cells };
    });
  }, [months, calc, start, end, ref.loading]);

  const totalCells = useMemo(() => {
    const cells = new Map<string, { fact: number; pct: number | null }>();
    const rev = total?.rows.find((r) => r.key === "h-rev")?.fact ?? 0;
    const walk = (rows: PnlRow[]) => {
      for (const r of rows) {
        const base = r.base ?? rev;
        cells.set(r.key, { fact: r.fact, pct: base > 0 ? (r.fact / base) * 100 : null });
        if (r.children) walk(r.children);
      }
    };
    if (total) walk(total.rows);
    return cells;
  }, [total]);

  const byKey = useMemo(() => new Map((total?.rows ?? []).map((r) => [r.key, r])), [total]);
  const revenue = byKey.get("h-rev");
  const gross = byKey.get("gross");
  const net = byKey.get("net");
  const marginPct = revenue && revenue.fact > 0 && gross ? (gross.fact / revenue.fact) * 100 : null;
  const netPct = revenue && revenue.fact > 0 && net ? (net.fact / revenue.fact) * 100 : null;
  const expensesPct = revenue && revenue.fact > 0 && total ? (total.expenses.fact / revenue.fact) * 100 : null;

  const isOpen = (r: PnlRow) => open[r.key] ?? false;

  function flat(rows: PnlRow[], depth = 0): { row: PnlRow; depth: number }[] {
    const out: { row: PnlRow; depth: number }[] = [];
    for (const r of rows) {
      out.push({ row: r, depth });
      if (r.children && r.children.length > 0 && isOpen(r)) out.push(...flat(r.children, depth + 1));
    }
    return out;
  }

  function allKeys(rows: PnlRow[], value: boolean): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    const walk = (list: PnlRow[]) => {
      for (const r of list) {
        if (r.children && r.children.length > 0) {
          out[r.key] = value;
          walk(r.children);
        }
      }
    };
    walk(rows);
    return out;
  }

  function pct(row: PnlRow): number | null {
    return row.plan > 0 ? (row.fact / row.plan) * 100 : null;
  }
  function tone(row: PnlRow): string {
    const p = pct(row);
    if (p === null) return "text-muted";
    const good = row.goodWhenHigh ? p >= 100 : p <= 100;
    if (good) return "text-accent";
    const near = row.goodWhenHigh ? p >= 85 : p <= 110;
    return near ? "text-[#B8752E]" : "text-[#A34B36]";
  }

  function exportXls() {
    if (!total) return;
    if (view === "months") {
      const headers = ["Статья", ...columns.flatMap((c) => [monthLabel(c.month), "%"]), "Итого", "%"];
      const rows = flat(total.rows).map(({ row, depth }) => [
        "   ".repeat(depth) + row.label,
        ...columns.flatMap((c) => {
          const cell = c.cells.get(row.key);
          return [Math.round(cell?.fact ?? 0), cell?.pct === null || cell === undefined ? "" : Math.round(cell.pct * 100) / 100];
        }),
        Math.round(totalCells.get(row.key)?.fact ?? 0),
        totalCells.get(row.key)?.pct === null || !totalCells.get(row.key) ? "" : Math.round((totalCells.get(row.key)!.pct as number) * 100) / 100,
      ]);
      downloadExcel(`ОПИУ_по_месяцам_${start}_${end}`, headers, rows);
      return;
    }
    const out: (string | number)[][] = flat(total.rows).map(({ row, depth }) => [
      "   ".repeat(depth) + row.label,
      Math.round(row.plan),
      Math.round(row.fact),
      Math.round(row.fact - row.plan),
      row.plan > 0 ? Math.round((row.fact / row.plan) * 100) : "",
    ]);
    downloadExcel(`ОПИУ_план_факт_${start}_${end}`, ["Статья", "План", "Факт", "Отклонение", "% выполнения"], out);
  }

  const storeScope = isAll ? "по всей компании" : selected.length === 1 ? stores.find((s) => s.code === selected[0])?.name ?? "" : `по выбранным магазинам (${selected.length})`;

  const rowStyle = (r: PnlRow) => (r.type === "total" ? "bg-paper font-bold" : r.type === "subtotal" ? "font-bold" : "");
  const labelCell = (r: PnlRow, depth: number) => {
    const kids = (r.children?.length ?? 0) > 0;
    return (
      <>
        <span
          style={{ paddingLeft: depth * 18 }}
          className={`inline-flex items-center ${kids ? "cursor-pointer select-none" : ""}`}
          onClick={kids ? () => setOpen((s) => ({ ...s, [r.key]: !isOpen(r) })) : undefined}
        >
          {kids ? (
            <span className="mr-1.5 text-[10px] text-muted w-3 inline-block">{isOpen(r) ? "▼" : "▶"}</span>
          ) : (
            <span className="inline-block w-[18px]" />
          )}
          <span className={depth > 0 ? "text-muted font-normal" : ""}>{r.label}</span>
        </span>
        {r.note && <span className="ml-2 text-[11px] text-mutedLight font-normal">({r.note})</span>}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="ОПИУ — прибыли и убытки"
        subtitle={`Отчёт ${storeScope}. Выручка и себестоимость — из МойСклад по категориям товара, расходы — из ДДС по статьям.`}
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <PeriodTabs preset={period.preset} onPreset={period.setPreset} from={period.from} onFrom={period.setFrom} to={period.to} onTo={period.setTo} />
        <div className="flex items-center gap-2">
          <button className={btnGhost} onClick={exportXls} disabled={!total}>Скачать Excel</button>
          {canEdit && <button className={btnPrimary} onClick={() => setPlanOpen(true)}>Внести план</button>}
        </div>
      </div>
      <ErrorBox message={error ?? ref.error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Выручка" value={revenue ? fmtMoney(revenue.fact) : "—"} note={view === "planfact" && revenue?.plan ? `${fmtPct(pct(revenue))} от плана` : "за выбранный период"} />
        <KpiCard label="Валовая прибыль" value={gross ? fmtMoney(gross.fact) : "—"} note={marginPct === null ? undefined : `маржа ${marginPct.toFixed(1)}%`} />
        <KpiCard label="Расходы" value={total ? fmtMoney(total.expenses.fact) : "—"} note={expensesPct === null ? undefined : `${expensesPct.toFixed(1)}% от выручки`} />
        <KpiCard label="Рентабельность" value={net ? fmtMoney(net.fact) : "—"} valueTone={(net?.fact ?? 0) < 0 ? "negative" : "positive"} note={netPct === null ? undefined : `${netPct.toFixed(1)}% от выручки`} />
      </div>

      <Tabs value={view} onChange={setView} items={[{ key: "months", label: "По месяцам" }, { key: "planfact", label: "План и факт" }]} />

      <Card>
        {loading || ref.loading ? (
          <Empty>Загрузка…</Empty>
        ) : !total ? (
          <Empty>Нет данных</Empty>
        ) : view === "months" ? (
          <>
            <div className="flex justify-end mb-2 gap-2">
              <button className={btnGhost} onClick={() => setOpen(allKeys(total.rows, true))}>Развернуть всё</button>
              <button className={btnGhost} onClick={() => setOpen({})}>Свернуть всё</button>
            </div>
            <div className="overflow-x-auto">
              <table className="border-collapse min-w-full">
                <thead>
                  <tr>
                    <th className={`${thCls} sticky left-0 bg-surface z-10 min-w-[240px]`}>Статья</th>
                    {columns.map((c) => (
                      <th key={c.month} colSpan={2} className={`${thCls} text-center`}>{monthLabel(c.month)}</th>
                    ))}
                    <th colSpan={2} className={`${thCls} text-center`}>Итого</th>
                  </tr>
                </thead>
                <tbody>
                  {flat(total.rows).map(({ row, depth }) => {
                    const style = rowStyle(row);
                    const sticky = row.type === "total" ? "bg-paper" : "bg-surface";
                    return (
                      <tr key={row.key} className={style}>
                        <td className={`${tdCls} sticky left-0 z-10 whitespace-nowrap ${sticky}`}>{labelCell(row, depth)}</td>
                        {columns.map((c) => {
                          const cell = c.cells.get(row.key);
                          return [
                            <td key={`${c.month}a`} className={`${tdCls} text-right num whitespace-nowrap ${depth > 0 ? "text-muted" : ""}`}>{cell && cell.fact !== 0 ? fmtNum(cell.fact) : <span className="text-mutedLight">—</span>}</td>,
                            <td key={`${c.month}p`} className={`${tdCls} text-right num whitespace-nowrap text-[12px] text-muted pl-1`}>{cell && cell.fact !== 0 ? pctText(cell.pct) : ""}</td>,
                          ];
                        })}
                        <td className={`${tdCls} text-right num whitespace-nowrap font-semibold border-l border-border`}>{(totalCells.get(row.key)?.fact ?? 0) !== 0 ? fmtNum(totalCells.get(row.key)!.fact) : <span className="text-mutedLight">—</span>}</td>
                        <td className={`${tdCls} text-right num whitespace-nowrap text-[12px] text-muted pl-1`}>{(totalCells.get(row.key)?.fact ?? 0) !== 0 ? pctText(totalCells.get(row.key)!.pct) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[560px]">
              <thead>
                <tr>
                  <th className={thCls}>Статья</th>
                  <th className={`${thCls} text-right`}>План</th>
                  <th className={`${thCls} text-right`}>Факт</th>
                  <th className={`${thCls} text-right`}>Отклонение</th>
                  <th className={`${thCls} text-right`}>% плана</th>
                </tr>
              </thead>
              <tbody>
                {flat(total.rows).map(({ row, depth }) => {
                  const diff = row.fact - row.plan;
                  const p = pct(row);
                  return (
                    <tr key={row.key} className={rowStyle(row)}>
                      <td className={`${tdCls} whitespace-nowrap`}>{labelCell(row, depth)}</td>
                      <td className={`${tdCls} text-right num`}>{row.plan ? fmtMoney(row.plan) : <span className="text-mutedLight">—</span>}</td>
                      <td className={`${tdCls} text-right num`}>{fmtMoney(row.fact)}</td>
                      <td className={`${tdCls} text-right num ${row.plan ? "" : "text-mutedLight"}`}>{row.plan ? `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${fmtMoney(Math.abs(diff))}` : "—"}</td>
                      <td className={`${tdCls} text-right num font-bold ${tone(row)}`}>{fmtPct(p)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {total && !loading && (
          <div className="mt-3 flex flex-col gap-1 text-[12px] text-muted">
            {view === "months" ? (
              <div>Серым справа от суммы — процент от выручки месяца. У себестоимости по категории — процент от выручки этой категории.</div>
            ) : (
              <div>% плана: доходы — чем выше, тем лучше; расходы — чем ниже, тем лучше. План вносится кнопкой «Внести план».</div>
            )}
            {!isAll && <div>При выборе отдельных магазинов общие расходы без магазина в отчёт не входят.</div>}
            {total.uncategorized > 0 && <div className="text-[#B8752E]">Операций без статьи за период: {total.uncategorized} — они не вошли в ОПИУ. Укажите статью в ДДС.</div>}
            {total.costMissing && <div className="text-[#B8752E]">В некоторых днях МойСклад не отдал себестоимость — прибыль может быть завышена.</div>}
          </div>
        )}
      </Card>

      {planOpen && (
        <PlanModal
          categories={ref.categories}
          stores={stores}
          defaultMonth={monthStart(start)}
          isAll={isAll}
          selected={selected}
          onClose={() => setPlanOpen(false)}
          onSaved={() => {
            setPlanOpen(false);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

// ── Внесение плана на месяц ────────────────────────────────────────────────
function PlanModal({
  categories,
  stores,
  defaultMonth,
  isAll,
  selected,
  onClose,
  onSaved,
}: {
  categories: FinCategory[];
  stores: { code: string; name: string }[];
  defaultMonth: string;
  isAll: boolean;
  selected: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [month, setMonth] = useState(defaultMonth.slice(0, 7));
  const [scope, setScope] = useState<string>(!isAll && selected.length === 1 ? selected[0] : "");
  const [values, setValues] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // статьи, по которым вообще имеет смысл план; автовыручка идёт из плана продаж
  const planCats = categories.filter((c) => c.opiu_group !== null && (c.active || values[c.id] !== undefined));
  const tops = planCats.filter((c) => c.parent_id === null);
  const groupsOrder: OpiuGroup[] = ["revenue", "cogs", ...EXPENSE_INDICATORS, "other_income", "other_expense"];

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      let q = supabase.from("fin_pnl_plan").select("category_id, amount").eq("plan_month", `${month}-01`);
      q = scope ? q.eq("store", scope) : q.is("store", null);
      const { data, error: e } = await q;
      if (cancelled) return;
      if (e) setError(e.message);
      const next: Record<number, string> = {};
      for (const r of (data ?? []) as { category_id: number; amount: number }[]) next[r.category_id] = String(Number(r.amount));
      setValues(next);
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [month, scope]);

  async function save() {
    setSaving(true);
    setError(null);
    const rows = Object.entries(values)
      .map(([id, v]) => ({ category_id: Number(id), amount: Number(String(v).replace(/\s/g, "").replace(",", ".")) }))
      .filter((r) => Number.isFinite(r.amount) && r.amount !== 0)
      .map((r) => ({ ...r, plan_month: `${month}-01`, store: scope || null }));
    let del = supabase.from("fin_pnl_plan").delete().eq("plan_month", `${month}-01`);
    del = scope ? del.eq("store", scope) : del.is("store", null);
    const d = await del;
    if (d.error) {
      setSaving(false);
      return setError(d.error.message);
    }
    if (rows.length > 0) {
      const ins = await supabase.from("fin_pnl_plan").insert(rows);
      if (ins.error) {
        setSaving(false);
        return setError(ins.error.message);
      }
    }
    setSaving(false);
    onSaved();
  }

  const input = (c: FinCategory) => (
    <div key={c.id} className="flex items-center justify-between gap-3 py-1.5">
      <span className={`text-[13px] ${c.parent_id ? "pl-5 text-muted" : "text-ink font-medium"}`}>{c.name}</span>
      <input
        className={`${inputCls} w-[150px] text-right`}
        value={values[c.id] ?? ""}
        onChange={(e) => setValues((s) => ({ ...s, [c.id]: e.target.value }))}
        inputMode="decimal"
        placeholder="0"
      />
    </div>
  );

  return (
    <Modal title="План ОПИУ на месяц" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Месяц"><input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
          <Field label="Для чего" hint="План по магазину или общий по компании">
            <select className={selectCls} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Вся компания (общий)</option>
              {stores.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </Field>
        </div>
        <p className="text-[12px] text-muted">
          Пустое поле — плана нет. План выручки можно не вносить: если не задан, берётся план из раздела «Продажа». Суммы в тенге за месяц; при просмотре части месяца план пересчитывается по дням.
        </p>
        {loading ? (
          <Empty>Загрузка…</Empty>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto border border-border rounded-md px-4 py-2">
            {groupsOrder.map((g) => {
              const inGroup = tops.filter((t) => t.opiu_group === g);
              if (inGroup.length === 0) return null;
              return (
                <div key={g} className="py-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-muted font-bold pt-2 pb-1">{OPIU_GROUP_LABEL[g]}</div>
                  {inGroup.map((t) => [input(t), ...planCats.filter((c) => c.parent_id === t.id).map(input)])}
                </div>
              );
            })}
          </div>
        )}
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving || loading}>Сохранить план</button>
        </div>
      </div>
    </Modal>
  );
}
