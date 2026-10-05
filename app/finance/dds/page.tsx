"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { downloadExcel } from "@/lib/exportExcel";
import {
  accountBalance,
  addDays,
  categoryPath,
  fmtDate,
  fmtMoney,
  isAutoCategory,
  loadAllOperations,
  monthLabel,
  monthStart,
  monthsInRange,
  todayYmd,
  useFinanceRef,
  usePeriod,
  type FinCategory,
  type FinOperation,
} from "@/lib/finance";
import {
  CategorySelect,
  Card,
  Chip,
  Empty,
  ErrorBox,
  Field,
  FinanceGuard,
  Modal,
  PageTitle,
  PeriodTabs,
  Tabs,
  btnDanger,
  btnGhost,
  btnPrimary,
  inputCls,
  selectCls,
  tdCls,
  thCls,
  useSection,
} from "@/components/finance/ui";
import KpiCard from "@/components/KpiCard";

export default function DdsPage() {
  return (
    <FinanceGuard section="finance.dds">
      <Inner />
    </FinanceGuard>
  );
}

type View = "ops" | "report";

function Inner() {
  const ref = useFinanceRef();
  const { stores } = useAuth();
  const { selected, isAll } = useStoreSelection();
  const { canEdit } = useSection("finance.dds");
  const period = usePeriod("month");
  const { start, end } = period.range;

  const [ops, setOps] = useState<FinOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("ops");
  const [accountFilter, setAccountFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Partial<FinOperation> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOps(await loadAllOperations());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить операции");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const storeName = (code: string | null) => (code ? stores.find((s) => s.code === code)?.name ?? code : "—");
  const accountName = (id: number | null) => ref.accounts.find((a) => a.id === id)?.name ?? "—";
  const supplierName = (id: number | null) => ref.suppliers.find((s) => s.id === id)?.name;
  const partnerName = (id: number | null) => ref.partners.find((p) => p.id === id)?.name;

  const visibleAccounts = useMemo(
    () => ref.accounts.filter((a) => isAll || (a.store !== null && selected.includes(a.store))),
    [ref.accounts, isAll, selected]
  );
  const visibleAccountIds = useMemo(() => new Set(visibleAccounts.map((a) => a.id)), [visibleAccounts]);

  // операции по выбранным магазинам (общие без магазина — только когда выбраны все)
  const scoped = useMemo(
    () => ops.filter((o) => (isAll ? true : o.store !== null ? selected.includes(o.store) : visibleAccountIds.has(o.account_id))),
    [ops, isAll, selected, visibleAccountIds]
  );
  const inPeriod = useMemo(() => scoped.filter((o) => o.op_date >= start && o.op_date <= end), [scoped, start, end]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inPeriod
      .filter((o) => !accountFilter || String(o.account_id) === accountFilter || String(o.to_account_id) === accountFilter)
      .filter((o) => !kindFilter || o.kind === kindFilter)
      .filter((o) => {
        if (!q) return true;
        const text = [categoryPath(ref.categories, o.category_id), o.comment, supplierName(o.supplier_id), partnerName(o.partner_id), accountName(o.account_id)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(q);
      })
      .sort((a, b) => (a.op_date === b.op_date ? b.id - a.id : b.op_date.localeCompare(a.op_date)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPeriod, accountFilter, kindFilter, query, ref.categories, ref.accounts, ref.suppliers, ref.partners]);

  const income = inPeriod.filter((o) => o.kind === "income").reduce((a, o) => a + o.amount, 0);
  const expense = inPeriod.filter((o) => o.kind === "expense").reduce((a, o) => a + o.amount, 0);
  const openingTotal = visibleAccounts.reduce((a, acc) => a + accountBalance(acc, ops, addDays(start, -1)), 0);
  const closingTotal = visibleAccounts.reduce((a, acc) => a + accountBalance(acc, ops, end), 0);

  async function remove(op: FinOperation) {
    if (!confirm(`Удалить операцию от ${fmtDate(op.op_date)} на ${fmtMoney(op.amount)}?`)) return;
    const { error: e } = await supabase.from("fin_operations").delete().eq("id", op.id);
    if (e) setError(e.message);
    load();
  }

  function exportExcel() {
    downloadExcel(
      `ДДС_${start}_${end}`,
      ["Дата", "Тип", "Счёт", "Статья", "Магазин", "Контрагент", "Комментарий", "Сумма"],
      rows.map((o) => [
        fmtDate(o.op_date),
        o.kind === "income" ? "Приход" : o.kind === "expense" ? "Расход" : "Перевод",
        o.kind === "transfer" ? `${accountName(o.account_id)} → ${accountName(o.to_account_id)}` : accountName(o.account_id),
        o.kind === "transfer" ? "Перевод между счетами" : categoryPath(ref.categories, o.category_id),
        storeName(o.store),
        supplierName(o.supplier_id) ?? partnerName(o.partner_id) ?? "",
        o.comment ?? "",
        o.kind === "expense" ? -o.amount : o.amount,
      ])
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="ДДС — движение денег"
        subtitle="Все поступления и выплаты по счетам и кассам. Продажи из МойСклад сюда не попадают — они в ОПИУ; здесь вносятся реальные деньги: инкассация, оплаты, переводы."
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <PeriodTabs preset={period.preset} onPreset={period.setPreset} from={period.from} onFrom={period.setFrom} to={period.to} onTo={period.setTo} />
        <div className="flex items-center gap-2">
          <button className={btnGhost} onClick={exportExcel}>Скачать Excel</button>
          {canEdit && (
            <button className={btnPrimary} onClick={() => setEditing({ op_date: todayYmd(), kind: "expense" })}>
              + Операция
            </button>
          )}
        </div>
      </div>
      <ErrorBox message={error ?? ref.error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Остаток на начало" value={fmtMoney(openingTotal)} />
        <KpiCard label="Поступления" value={fmtMoney(income)} valueTone="positive" />
        <KpiCard label="Выплаты" value={fmtMoney(expense)} valueTone="negative" />
        <KpiCard
          label="Остаток на конец"
          value={fmtMoney(closingTotal)}
          valueTone={closingTotal < 0 ? "negative" : "neutral"}
          note={`Поток: ${income - expense >= 0 ? "+" : "−"}${fmtMoney(Math.abs(income - expense))}`}
          noteTone={income - expense >= 0 ? "positive" : "negative"}
        />
      </div>

      <Tabs value={view} onChange={setView} items={[{ key: "ops", label: "Операции" }, { key: "report", label: "Отчёт ДДС по статьям" }]} />

      {view === "ops" && (
        <Card
          title={`Операции (${rows.length})`}
          right={
            <div className="flex gap-2 flex-wrap">
              <input className={`${inputCls} w-[160px]`} placeholder="Поиск…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select className={`${selectCls} w-[150px]`} value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                <option value="">Все типы</option>
                <option value="income">Приход</option>
                <option value="expense">Расход</option>
                <option value="transfer">Перевод</option>
              </select>
              <select className={`${selectCls} w-[170px]`} value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
                <option value="">Все счета</option>
                {visibleAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          }
        >
          {loading ? (
            <Empty>Загрузка…</Empty>
          ) : rows.length === 0 ? (
            <Empty>{ref.accounts.length === 0 ? "Сначала добавьте счета в «Настройки → Счета», потом вносите операции." : "За выбранный период операций нет"}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={thCls}>Дата</th>
                    <th className={thCls}>Счёт</th>
                    <th className={thCls}>Статья</th>
                    <th className={thCls}>Магазин</th>
                    <th className={thCls}>Контрагент / комментарий</th>
                    <th className={`${thCls} text-right`}>Сумма</th>
                    <th className={thCls} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id}>
                      <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(o.op_date)}</td>
                      <td className={tdCls}>
                        {o.kind === "transfer" ? `${accountName(o.account_id)} → ${accountName(o.to_account_id)}` : accountName(o.account_id)}
                      </td>
                      <td className={tdCls}>
                        {o.kind === "transfer" ? (
                          <Chip tone="muted">Перевод</Chip>
                        ) : o.category_id === null ? (
                          o.debt_id ? <Chip tone="muted">Погашение долга</Chip> : <Chip tone="warn">Без статьи</Chip>
                        ) : (
                          categoryPath(ref.categories, o.category_id)
                        )}
                      </td>
                      <td className={tdCls}>{storeName(o.store)}</td>
                      <td className={tdCls}>
                        {[supplierName(o.supplier_id), partnerName(o.partner_id)].filter(Boolean).join(", ")}
                        {o.comment && <div className="text-muted text-[12px]">{o.comment}</div>}
                      </td>
                      <td className={`${tdCls} text-right num font-semibold whitespace-nowrap ${o.kind === "income" ? "text-accent" : o.kind === "expense" ? "text-[#A34B36]" : "text-muted"}`}>
                        {o.kind === "income" ? "+" : o.kind === "expense" ? "−" : ""}
                        {fmtMoney(o.amount)}
                      </td>
                      <td className={`${tdCls} text-right whitespace-nowrap`}>
                        {canEdit && (
                          <div className="flex gap-1.5 justify-end">
                            <button className={btnGhost} onClick={() => setEditing(o)}>Изменить</button>
                            <button className={btnDanger} onClick={() => remove(o)}>×</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {view === "report" && (
        <DdsReport start={start} end={end} ops={scoped} categories={ref.categories} openingTotal={openingTotal} accounts={visibleAccounts} allOps={ops} />
      )}

      {editing && (
        <OperationModal
          initial={editing}
          ref_={ref}
          stores={stores}
          defaultStore=""
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ── Отчёт ДДС: статьи × месяцы ─────────────────────────────────────────────
function DdsReport({
  start,
  end,
  ops,
  categories,
  accounts,
  allOps,
}: {
  start: string;
  end: string;
  ops: FinOperation[];
  categories: FinCategory[];
  openingTotal: number;
  accounts: ReturnType<typeof useFinanceRef>["accounts"];
  allOps: FinOperation[];
}) {
  const months = useMemo(() => {
    const all = monthsInRange(start, end).slice(0, 12);
    const upto = all.filter((m) => m <= monthStart(todayYmd()));
    return upto.length > 0 ? upto : all; // будущие месяцы без данных не показываем
  }, [start, end]);

  const data = useMemo(() => {
    const byCat = new Map<number | "none", Map<string, number>>();
    const kindOf = new Map<number | "none", "income" | "expense">();
    for (const o of ops) {
      if (o.kind === "transfer" || o.op_date < start || o.op_date > end) continue;
      const key = o.category_id ?? "none";
      const m = monthStart(o.op_date);
      const cell = byCat.get(key) ?? new Map<string, number>();
      cell.set(m, (cell.get(m) ?? 0) + o.amount);
      byCat.set(key, cell);
      kindOf.set(key, o.kind);
    }
    function collect(kind: "income" | "expense") {
      const lines: { key: string; label: string; level: 0 | 1; cells: number[] }[] = [];
      const topIds = new Set<number>();
      for (const key of byCat.keys()) {
        if (key === "none") continue;
        const c = categories.find((x) => x.id === key);
        if (c && c.kind === kind) topIds.add(c.parent_id ?? c.id);
      }
      const cellsOf = (id: number) => months.map((m) => byCat.get(id)?.get(m) ?? 0);
      for (const topId of [...topIds].sort((a, b) => (categories.find((c) => c.id === a)?.sort ?? 0) - (categories.find((c) => c.id === b)?.sort ?? 0))) {
        const top = categories.find((c) => c.id === topId)!;
        const kids = categories.filter((c) => c.parent_id === topId);
        const own = cellsOf(topId);
        const kidCells = kids.map((k) => ({ k, cells: cellsOf(k.id) }));
        const total = months.map((_, i) => own[i] + kidCells.reduce((a, x) => a + x.cells[i], 0));
        lines.push({ key: `t${topId}`, label: top.name, level: 0, cells: total });
        if (kids.length > 0 && own.some((v) => v)) lines.push({ key: `o${topId}`, label: "Без подпункта", level: 1, cells: own });
        for (const kc of kidCells) if (kc.cells.some((v) => v)) lines.push({ key: `k${kc.k.id}`, label: kc.k.name, level: 1, cells: kc.cells });
      }
      if (byCat.has("none") && kindOf.get("none") === kind) {
        lines.push({ key: "none", label: "Без статьи", level: 0, cells: months.map((m) => byCat.get("none")?.get(m) ?? 0) });
      }
      return lines;
    }
    return { income: collect("income"), expense: collect("expense") };
  }, [ops, categories, months, start, end]);

  const sumTop = (lines: { level: 0 | 1; cells: number[] }[]) => months.map((_, i) => lines.filter((l) => l.level === 0).reduce((a, l) => a + l.cells[i], 0));
  const inc = sumTop(data.income);
  const exp = sumTop(data.expense);

  // остатки на начало и конец каждого месяца
  const opening = months.map((m) => {
    const dayBefore = addDays(m < start ? start : m, -1);
    return accounts.reduce((a, acc) => a + accountBalance(acc, allOps, dayBefore), 0);
  });
  const closing = months.map((m) => {
    const last = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0);
    const monthEnd = `${m.slice(0, 7)}-${String(last.getDate()).padStart(2, "0")}`;
    return accounts.reduce((a, acc) => a + accountBalance(acc, allOps, monthEnd > end ? end : monthEnd), 0);
  });

  const th = `${thCls} text-right`;
  const num = (v: number) => (v === 0 ? <span className="text-mutedLight">—</span> : fmtMoney(v));
  const total = (cells: number[]) => cells.reduce((a, v) => a + v, 0);

  function exportXls() {
    const body: (string | number)[][] = [];
    body.push(["Остаток на начало", ...opening, ""]);
    body.push(["ПОСТУПЛЕНИЯ", ...months.map(() => ""), ""]);
    for (const l of data.income) body.push([(l.level ? "   " : "") + l.label, ...l.cells, total(l.cells)]);
    body.push(["Итого поступлений", ...inc, total(inc)]);
    body.push(["ВЫПЛАТЫ", ...months.map(() => ""), ""]);
    for (const l of data.expense) body.push([(l.level ? "   " : "") + l.label, ...l.cells, total(l.cells)]);
    body.push(["Итого выплат", ...exp, total(exp)]);
    body.push(["Чистый поток", ...months.map((_, i) => inc[i] - exp[i]), total(inc) - total(exp)]);
    body.push(["Остаток на конец", ...closing, ""]);
    downloadExcel(`ДДС_отчёт_${start}_${end}`, ["Статья", ...months.map(monthLabel), "Итого"], body);
  }

  const sectionRow = (label: string) => (
    <tr key={label}>
      <td colSpan={months.length + 2} className="px-3 py-2 text-[11px] uppercase tracking-wide font-bold text-muted bg-paper border-b border-border">
        {label}
      </td>
    </tr>
  );
  const lineRow = (l: { key: string; label: string; level: 0 | 1; cells: number[] }) => (
    <tr key={l.key}>
      <td className={`${tdCls} ${l.level ? "pl-8 text-muted" : "font-semibold"}`}>{l.label}</td>
      {l.cells.map((v, i) => <td key={i} className={`${tdCls} text-right num ${l.level ? "text-muted" : ""}`}>{num(v)}</td>)}
      <td className={`${tdCls} text-right num font-semibold`}>{num(total(l.cells))}</td>
    </tr>
  );
  const sumRow = (label: string, cells: number[], tone = "") => (
    <tr key={label} className="bg-paper">
      <td className={`${tdCls} font-bold ${tone}`}>{label}</td>
      {cells.map((v, i) => <td key={i} className={`${tdCls} text-right num font-bold ${tone}`}>{fmtMoney(v)}</td>)}
      <td className={`${tdCls} text-right num font-bold ${tone}`}>{fmtMoney(total(cells))}</td>
    </tr>
  );

  if (data.income.length === 0 && data.expense.length === 0) return <Card><Empty>За период нет операций с доходами или расходами</Empty></Card>;

  return (
    <Card title="Отчёт о движении денег" right={<button className={btnGhost} onClick={exportXls}>Скачать Excel</button>}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[560px]">
          <thead>
            <tr>
              <th className={thCls}>Статья</th>
              {months.map((m) => <th key={m} className={th}>{monthLabel(m)}</th>)}
              <th className={th}>Итого</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${tdCls} text-muted`}>Остаток на начало</td>
              {opening.map((v, i) => <td key={i} className={`${tdCls} text-right num text-muted`}>{fmtMoney(v)}</td>)}
              <td className={tdCls} />
            </tr>
            {sectionRow("Поступления")}
            {data.income.map(lineRow)}
            {sumRow("Итого поступлений", inc, "text-accent")}
            {sectionRow("Выплаты")}
            {data.expense.map(lineRow)}
            {sumRow("Итого выплат", exp, "text-[#A34B36]")}
            {sumRow("Чистый поток", months.map((_, i) => inc[i] - exp[i]))}
            <tr>
              <td className={`${tdCls} font-bold`}>Остаток на конец</td>
              {closing.map((v, i) => <td key={i} className={`${tdCls} text-right num font-bold ${v < 0 ? "text-[#A34B36]" : ""}`}>{fmtMoney(v)}</td>)}
              <td className={tdCls} />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-muted mt-3">Переводы между счетами не показаны — они меняют остатки по счетам, но не общую сумму денег.</p>
    </Card>
  );
}

// ── Окно операции ──────────────────────────────────────────────────────────
function OperationModal({
  initial,
  ref_,
  stores,
  defaultStore,
  onClose,
  onSaved,
}: {
  initial: Partial<FinOperation>;
  ref_: ReturnType<typeof useFinanceRef>;
  stores: { code: string; name: string }[];
  defaultStore: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<FinOperation["kind"]>(initial.kind ?? "expense");
  const [date, setDate] = useState(initial.op_date ?? todayYmd());
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : "");
  const [accountId, setAccountId] = useState(initial.account_id ? String(initial.account_id) : "");
  const [toAccountId, setToAccountId] = useState(initial.to_account_id ? String(initial.to_account_id) : "");
  const [categoryId, setCategoryId] = useState(initial.category_id ? String(initial.category_id) : "");
  // магазин обязателен; предвыбираем его, если в шапке выбран ровно один
  const [store, setStore] = useState(initial.store ?? (initial.id ? "" : defaultStore));
  const [supplierId, setSupplierId] = useState(initial.supplier_id ? String(initial.supplier_id) : "");
  const [comment, setComment] = useState(initial.comment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // поставщик нужен только для статей вроде «Закуп - товар»
  const needSupplier = kind === "expense" && !!ref_.categories.find((c) => String(c.id) === categoryId)?.require_supplier;
  const activeAccounts = ref_.accounts.filter((a) => a.active || String(a.id) === accountId);
  const cats = ref_.categories.filter(
    (c) => c.kind === (kind === "income" ? "income" : "expense") && ((c.active && !isAutoCategory(c, ref_.settings)) || String(c.id) === categoryId)
  );
  const tops = cats.filter((c) => c.parent_id === null);

  async function save() {
    const amt = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) return setError("Сумма должна быть больше нуля");
    if (!accountId) return setError("Выберите счёт");
    if (kind === "transfer" && (!toAccountId || toAccountId === accountId)) return setError("Выберите другой счёт, куда переводятся деньги");
    if (kind !== "transfer" && !categoryId) return setError("Выберите статью");
    // у старых операций «без магазина» можно сохранять как есть, у новых магазин обязателен
    if (kind !== "transfer" && !store && !(initial.id && initial.store === null)) return setError("Выберите магазин");
    if (needSupplier && !supplierId) return setError("Для этой статьи выберите поставщика");
    setSaving(true);
    setError(null);
    const payload = {
      op_date: date,
      kind,
      amount: amt,
      account_id: Number(accountId),
      to_account_id: kind === "transfer" ? Number(toAccountId) : null,
      category_id: kind === "transfer" ? null : Number(categoryId),
      store: store || null,
      supplier_id: needSupplier && supplierId ? Number(supplierId) : null,
      partner_id: initial.partner_id ?? null, // партнёр вносится только в разделе «Долги»
      comment: comment.trim() || null,
    };
    const res = initial.id
      ? await supabase.from("fin_operations").update(payload).eq("id", initial.id)
      : await supabase.from("fin_operations").insert(payload);
    setSaving(false);
    if (res.error) return setError(res.error.message);
    onSaved();
  }

  return (
    <Modal title={initial.id ? "Изменить операцию" : "Новая операция"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div className="flex gap-1.5 bg-paper border border-border rounded-md p-1 w-fit">
          {([["expense", "Расход"], ["income", "Приход"], ["transfer", "Перевод"]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => { setKind(k); setCategoryId(""); }}
              className={`text-[13px] rounded px-4 py-1.5 ${kind === k ? "bg-accent text-paper font-bold" : "text-muted font-medium"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Дата"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Сумма, ₸"><input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus /></Field>
        </div>
        {kind !== "transfer" && (
          <Field label="Магазин">
            <select className={selectCls} value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">Выберите…</option>
              {stores.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </Field>
        )}
        <div className={kind === "transfer" ? "grid grid-cols-2 gap-3" : ""}>
          <Field label={kind === "transfer" ? "Со счёта" : kind === "income" ? "На счёт" : "Со счёта"}>
            <select className={selectCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Выберите…</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          {kind === "transfer" && (
            <Field label="На счёт">
              <select className={selectCls} value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                <option value="">Выберите…</option>
                {activeAccounts.filter((a) => String(a.id) !== accountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        {kind !== "transfer" && (
          <>
            <CategorySelect categories={cats} value={categoryId} onChange={setCategoryId} />
            {needSupplier && (
              <Field label="Поставщик">
                <select className={selectCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Выберите…</option>
                  {ref_.suppliers.filter((s) => s.active || String(s.id) === supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
            )}
          </>
        )}
        <Field label="Комментарий"><input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>Сохранить</button>
        </div>
      </div>
    </Modal>
  );
}
