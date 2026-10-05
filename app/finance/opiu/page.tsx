"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { downloadExcel } from "@/lib/exportExcel";
import KpiCard from "@/components/KpiCard";
import {
  computePnl,
  fmtMoney,
  fmtPct,
  loadPnlInputs,
  monthStart,
  OPIU_GROUP_LABEL,
  useFinanceRef,
  usePeriod,
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

function Inner() {
  const ref = useFinanceRef();
  const { stores } = useAuth();
  const { selected, isAll } = useStoreSelection();
  const { canEdit } = useSection("finance.opiu");
  const period = usePeriod("month");
  const { start, end } = period.range;

  const [result, setResult] = useState<PnlResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [planOpen, setPlanOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (ref.loading) return;
    setLoading(true);
    setError(null);
    try {
      const inputs = await loadPnlInputs(start, end);
      setResult(
        computePnl({
          start,
          end,
          isAllStores: isAll,
          selectedStores: selected,
          settings: ref.settings,
          categories: ref.categories,
          ...inputs,
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось построить отчёт");
    } finally {
      setLoading(false);
    }
  }, [start, end, isAll, selected, ref.loading, ref.settings, ref.categories]);

  useEffect(() => {
    load();
  }, [load, tick]);

  const byKey = useMemo(() => new Map((result?.rows ?? []).map((r) => [r.key, r])), [result]);
  const revenue = byKey.get("h-rev");
  const gross = byKey.get("gross");
  const net = byKey.get("net");
  const marginPct = revenue && revenue.fact > 0 && gross ? (gross.fact / revenue.fact) * 100 : null;
  const netPct = revenue && revenue.fact > 0 && net ? (net.fact / revenue.fact) * 100 : null;

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
    if (!result) return;
    const out: (string | number)[][] = [];
    const push = (r: PnlRow, indent: string) => {
      out.push([indent + r.label, Math.round(r.plan), Math.round(r.fact), Math.round(r.fact - r.plan), r.plan > 0 ? Math.round((r.fact / r.plan) * 100) : ""]);
      for (const c of r.children ?? []) {
        push(c, indent + "   ");
      }
    };
    result.rows.forEach((r) => push(r, ""));
    downloadExcel(`ОПИУ_${start}_${end}`, ["Статья", "План", "Факт", "Отклонение", "% выполнения"], out);
  }

  const storeScope = isAll ? "по всей компании" : selected.length === 1 ? stores.find((s) => s.code === selected[0])?.name ?? "" : `по выбранным магазинам (${selected.length})`;

  function renderRows(rows: PnlRow[]): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    for (const r of rows) {
      const hasKids = (r.children?.length ?? 0) > 0;
      const expanded = open[r.key] ?? r.type === "subtotal";
      const isTotal = r.type === "total";
      const isSub = r.type === "subtotal";
      const p = pct(r);
      const diff = r.fact - r.plan;
      out.push(
        <tr key={r.key} className={isTotal ? "bg-paper" : ""}>
          <td className={`${tdCls} ${isTotal ? "font-bold" : isSub ? "font-bold" : r.level ? "pl-9 text-muted" : "pl-6 font-medium"}`}>
            {hasKids ? (
              <button type="button" onClick={() => setOpen((s) => ({ ...s, [r.key]: !expanded }))} className="mr-1.5 text-[10px] text-muted w-3 inline-block">
                {expanded ? "▼" : "▶"}
              </button>
            ) : (
              <span className="inline-block w-[18px]" />
            )}
            {r.label}
            {r.note && <span className="ml-2 text-[11px] text-mutedLight font-normal">({r.note})</span>}
          </td>
          <td className={`${tdCls} text-right num ${isTotal || isSub ? "font-bold" : ""}`}>{r.plan ? fmtMoney(r.plan) : <span className="text-mutedLight">—</span>}</td>
          <td className={`${tdCls} text-right num ${isTotal || isSub ? "font-bold" : ""}`}>{fmtMoney(r.fact)}</td>
          <td className={`${tdCls} text-right num ${r.plan ? "" : "text-mutedLight"}`}>
            {r.plan ? `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${fmtMoney(Math.abs(diff))}` : "—"}
          </td>
          <td className={`${tdCls} text-right num font-bold ${tone(r)}`}>{fmtPct(p)}</td>
        </tr>
      );
      if (hasKids && expanded) out.push(...renderRows(r.children!));
    }
    return out;
  }

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="ОПИУ — прибыли и убытки"
        subtitle={`План и факт по статьям ${storeScope}. Выручка и себестоимость берутся из МойСклад, расходы — из ДДС по статьям с группой ОПИУ.`}
        actions={
          <>
            <button className={btnGhost} onClick={exportXls} disabled={!result}>Скачать Excel</button>
            {canEdit && <button className={btnPrimary} onClick={() => setPlanOpen(true)}>Внести план</button>}
          </>
        }
      />
      <PeriodTabs preset={period.preset} onPreset={period.setPreset} from={period.from} onFrom={period.setFrom} to={period.to} onTo={period.setTo} />
      <ErrorBox message={error ?? ref.error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Выручка" value={revenue ? fmtMoney(revenue.fact) : "—"} note={revenue?.plan ? `${fmtPct(pct(revenue))} от плана` : "план не задан"} noteTone={revenue && pct(revenue) !== null && (pct(revenue) as number) >= 100 ? "positive" : "neutral"} />
        <KpiCard label="Валовая прибыль" value={gross ? fmtMoney(gross.fact) : "—"} note={marginPct === null ? undefined : `маржа ${marginPct.toFixed(1)}%`} />
        <KpiCard label="Операционная прибыль" value={byKey.get("operating") ? fmtMoney(byKey.get("operating")!.fact) : "—"} valueTone={(byKey.get("operating")?.fact ?? 0) < 0 ? "negative" : "neutral"} />
        <KpiCard label="Чистая прибыль" value={net ? fmtMoney(net.fact) : "—"} valueTone={(net?.fact ?? 0) < 0 ? "negative" : "positive"} note={netPct === null ? undefined : `${netPct.toFixed(1)}% от выручки`} />
      </div>

      <Card>
        {loading || ref.loading ? (
          <Empty>Загрузка…</Empty>
        ) : !result ? (
          <Empty>Нет данных</Empty>
        ) : (
          <>
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
                <tbody>{renderRows(result.rows)}</tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-col gap-1 text-[12px] text-muted">
              <div>% плана: доходы — чем выше, тем лучше; расходы — чем ниже, тем лучше. Для расходов выше 100% плана цифра краснеет.</div>
              {!isAll && <div>При выборе отдельных магазинов общие расходы без магазина в отчёт не входят.</div>}
              {result.uncategorized > 0 && <div className="text-[#B8752E]">Операций без статьи за период: {result.uncategorized} — они не вошли в ОПИУ. Укажите статью в ДДС.</div>}
              {result.costMissing && <div className="text-[#B8752E]">В некоторых днях МойСклад не отдал себестоимость — прибыль может быть завышена.</div>}
            </div>
          </>
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
  const groupsOrder: OpiuGroup[] = ["revenue", "cogs", "opex", "other_income", "other_expense", "tax"];

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
