"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { downloadExcel } from "@/lib/exportExcel";
import KpiCard from "@/components/KpiCard";
import {
  addDays,
  createChangeRequest,
  daysBetween,
  debtDirection,
  debtRemaining,
  findCategory,
  fmtDate,
  fmtMoney,
  fmtTime,
  isUnlocked,
  loadDebts,
  loadPendingRequestIds,
  logChange,
  todayYmd,
  useFinanceRef,
  type FinDebt,
  type FinDebtPayment,
} from "@/lib/finance";
import {
  Card,
  Chip,
  Empty,
  ErrorBox,
  Field,
  FinanceGuard,
  Modal,
  PageTitle,
  RequestModal,
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

export default function DebtsPage() {
  return (
    <FinanceGuard section="finance.debts">
      <Inner />
    </FinanceGuard>
  );
}

type Kind = FinDebt["kind"];
const KIND_LABEL: Record<Kind, string> = {
  store_store: "Между магазинами",
  supplier: "Магазин ↔ поставщики",
};

type Ref = ReturnType<typeof useFinanceRef>;
type Account = Ref["accounts"][number];

function ageDays(d: FinDebt, today: string): number {
  return Math.max(0, daysBetween(d.debt_date, today));
}

function Inner() {
  const ref = useFinanceRef();
  const { stores, fullName, email } = useAuth();
  const byName = fullName || email || "—";
  const { selected, isAll } = useStoreSelection();
  const { canEdit } = useSection("finance.debts");
  const [kind, setKind] = useState<Kind>("supplier");
  const [debts, setDebts] = useState<FinDebt[]>([]);
  const [payments, setPayments] = useState<FinDebtPayment[]>([]);
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<Partial<FinDebt> | null>(null);
  const [paying, setPaying] = useState<FinDebt | null>(null);
  const [requesting, setRequesting] = useState<FinDebt | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showPayments, setShowPayments] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await loadDebts();
      setDebts(r.debts);
      setPayments(r.payments);
      setPending(await loadPendingRequestIds("fin_debts"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить долги");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // открываем первую вкладку, где есть долги, один раз после загрузки
  const [tabPicked, setTabPicked] = useState(false);
  useEffect(() => {
    if (tabPicked || loading) return;
    setTabPicked(true);
    const kinds: Kind[] = ["supplier", "store_store"];
    const first = kinds.find((k) => debts.some((d) => d.kind === k && debtRemaining(d, payments) > 0));
    if (first) setKind(first);
  }, [tabPicked, loading, debts, payments]);

  const storeName = (code: string | null) => (code ? stores.find((s) => s.code === code)?.name ?? code : "—");
  const supplierName = (id: number | null) => ref.suppliers.find((s) => s.id === id)?.name ?? "—";
  const today = todayYmd();

  const scoped = useMemo(
    () => debts.filter((d) => isAll || selected.includes(d.store) || (d.counterparty_store !== null && selected.includes(d.counterparty_store))),
    [debts, isAll, selected]
  );
  const withRemaining = useMemo(() => scoped.map((d) => ({ d, rem: debtRemaining(d, payments) })), [scoped, payments]);
  const open = withRemaining.filter((x) => x.rem > 0);

  const dirOf = (d: FinDebt) => debtDirection(d, isAll, selected);
  const sum = (rows: typeof open, dir: "payable" | "receivable") => rows.filter((x) => dirOf(x.d) === dir).reduce((a, x) => a + x.rem, 0);
  const weOwe = sum(open, "payable");
  const owedToUs = sum(open, "receivable");
  const isOverdue = (x: { d: FinDebt }) => !!x.d.due_date && x.d.due_date < today;
  const overduePayable = open.filter((x) => isOverdue(x) && dirOf(x.d) === "payable").reduce((a, x) => a + x.rem, 0);
  const overdueReceivable = open.filter((x) => isOverdue(x) && dirOf(x.d) === "receivable").reduce((a, x) => a + x.rem, 0);

  function directionLabel(d: FinDebt): string {
    if (d.kind === "store_store") return `${storeName(d.store)} должен ${storeName(d.counterparty_store)}`;
    return d.direction === "payable" ? "Мы должны поставщику" : "Предоплата поставщику";
  }
  function counterpartyName(d: FinDebt): string {
    if (d.kind === "supplier") return supplierName(d.supplier_id);
    return `${storeName(d.store)} → ${storeName(d.counterparty_store)}`;
  }
  const describeDebt = (d: FinDebt) => `${KIND_LABEL[d.kind]}: ${directionLabel(d)}${d.kind === "store_store" ? "" : ` · ${counterpartyName(d)}`} · ${fmtMoney(d.amount)} от ${fmtDate(d.debt_date)}`;

  // группы по контрагенту (у магазинов — по паре)
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; rows: typeof withRemaining }>();
    for (const x of withRemaining.filter((r) => r.d.kind === kind && (showClosed || r.rem > 0))) {
      const d = x.d;
      let key: string;
      let label: string;
      if (d.kind === "supplier") {
        key = `s${d.supplier_id}`;
        label = supplierName(d.supplier_id);
      } else {
        const [a, b] = [d.store, d.counterparty_store ?? ""].sort();
        key = `${a}|${b}`;
        label = `${storeName(a)} ↔ ${storeName(b)}`;
      }
      const g = map.get(key) ?? { key, label, rows: [] };
      g.rows.push(x);
      map.set(key, g);
    }
    return [...map.values()]
      .map((g) => ({ ...g, rows: g.rows.sort((a, b) => (a.d.due_date ?? "9999").localeCompare(b.d.due_date ?? "9999") || a.d.debt_date.localeCompare(b.d.debt_date)) }))
      .sort((a, b) => a.label.localeCompare(b.label, "ru"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withRemaining, kind, showClosed, stores, ref.suppliers]);

  // возраст открытых долгов выбранной вкладки по направлениям
  const aging = useMemo(() => {
    const out: Record<"payable" | "receivable", [number, number, number]> = { payable: [0, 0, 0], receivable: [0, 0, 0] };
    for (const x of open.filter((r) => r.d.kind === kind)) {
      const dir = dirOf(x.d) ?? "payable";
      const age = ageDays(x.d, today);
      out[dir][age <= 30 ? 0 : age <= 60 ? 1 : 2] += x.rem;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, today, isAll, selected]);

  function groupSummary(g: (typeof groups)[number]) {
    const openRows = g.rows.filter((x) => x.rem > 0);
    if (kind === "store_store") {
      const [a] = g.key.split("|");
      const net = openRows.reduce((acc, x) => acc + (x.d.store === a ? x.rem : -x.rem), 0);
      const [x, y] = g.label.split(" ↔ ");
      const text = net === 0 ? "взаимные долги закрыты" : net > 0 ? `${x} должен ${y}: ${fmtMoney(net)}` : `${y} должен ${x}: ${fmtMoney(-net)}`;
      return { text, overdue: openRows.filter(isOverdue).reduce((acc, r) => acc + r.rem, 0) };
    }
    const owe = openRows.filter((r) => r.d.direction === "payable").reduce((acc, r) => acc + r.rem, 0);
    const owed = openRows.filter((r) => r.d.direction === "receivable").reduce((acc, r) => acc + r.rem, 0);
    const parts: string[] = [];
    if (owe) parts.push(`мы должны: ${fmtMoney(owe)}`);
    if (owed) parts.push(`предоплата: ${fmtMoney(owed)}`);
    return { text: parts.join(" · ") || "долгов нет", overdue: openRows.filter(isOverdue).reduce((acc, r) => acc + r.rem, 0) };
  }

  async function removePayment(p: FinDebtPayment, debt: FinDebt) {
    if (!confirm(`Удалить погашение ${fmtMoney(p.amount)}? Связанная операция в ДДС тоже будет удалена.`)) return;
    if (p.operation_id) await supabase.from("fin_operations").delete().eq("id", p.operation_id);
    const { error: e } = await supabase.from("fin_debt_payments").delete().eq("id", p.id);
    if (e) setError(e.message);
    else {
      await supabase.from("fin_debts").update({ closed: false }).eq("id", debt.id);
      await logChange({ table: "fin_debts", rowId: debt.id, store: debt.store, summary: `Погашение удалено: ${fmtMoney(p.amount)} от ${fmtDate(p.pay_date)} (${describeDebt(debt)})`, byName });
    }
    load();
  }
  async function removeDebt(d: FinDebt) {
    if (!confirm("Удалить долг вместе с историей погашений и связанными операциями в ДДС?")) return;
    await supabase.from("fin_operations").delete().eq("debt_id", d.id);
    const { error: e } = await supabase.from("fin_debts").delete().eq("id", d.id);
    if (e) setError(e.message);
    else await logChange({ table: "fin_debts", rowId: d.id, store: d.store, summary: `Долг удалён: ${describeDebt(d)}`, byName });
    load();
  }

  function exportXls() {
    downloadExcel(
      "Долги",
      ["Вид", "Долг", "Контрагент", "Магазин", "№ накладной", "Дата долга", "Срок", "Возраст, дн.", "Сумма долга", "Погашено", "Остаток", "Комментарий"],
      withRemaining
        .filter((x) => x.rem > 0)
        .map(({ d, rem }) => [KIND_LABEL[d.kind], directionLabel(d), counterpartyName(d), storeName(d.store), d.doc_number ?? "", fmtDate(d.debt_date), fmtDate(d.due_date), ageDays(d, today), d.amount, d.amount - rem, rem, d.comment ?? ""])
    );
  }

  const agingLine = (dir: "payable" | "receivable", label: string) => {
    const [a, b, c] = aging[dir];
    if (a + b + c === 0) return null;
    return (
      <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted">
        <span className="font-semibold text-ink">{label}:</span>
        <Chip tone="muted">до 30 дн. {fmtMoney(a)}</Chip>
        <Chip tone={b ? "warn" : "muted"}>31–60 дн. {fmtMoney(b)}</Chip>
        <Chip tone={c ? "bad" : "muted"}>свыше 60 дн. {fmtMoney(c)}</Chip>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="Долги"
        subtitle="Кто кому должен: поставщики и расчёты между магазинами. Остаток считается по погашениям, деньги по ним проводятся в ДДС."
      />
      <ErrorBox message={error ?? ref.error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Мы должны" value={fmtMoney(weOwe)} valueTone={weOwe > 0 ? "warning" : "neutral"} />
        <KpiCard label="Нам должны" value={fmtMoney(owedToUs)} valueTone="positive" />
        <KpiCard label="Просрочено нами" value={fmtMoney(overduePayable)} valueTone={overduePayable > 0 ? "negative" : "neutral"} note={overduePayable ? "срок оплаты прошёл" : "просрочек нет"} noteTone={overduePayable ? "negative" : "neutral"} />
        <KpiCard label="Просрочено нам" value={fmtMoney(overdueReceivable)} valueTone={overdueReceivable > 0 ? "warning" : "neutral"} note={overdueReceivable ? "должники не вернули в срок" : "просрочек нет"} />
      </div>

      <Tabs value={kind} onChange={setKind} items={(["supplier", "store_store"] as Kind[]).map((k) => ({ key: k, label: `${KIND_LABEL[k]} (${open.filter((x) => x.d.kind === k).length})` }))} />

      <Card
        title={KIND_LABEL[kind]}
        right={
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> показывать закрытые
            </label>
            <button className={btnGhost} onClick={exportXls}>Скачать Excel</button>
            {canEdit && (
              <button className={btnPrimary} onClick={() => setEditing({ kind, direction: "payable" })}>
                + Долг
              </button>
            )}
          </div>
        }
      >
        {loading ? (
          <Empty>Загрузка…</Empty>
        ) : groups.length === 0 ? (
          <Empty>Долгов нет</Empty>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              {agingLine("receivable", "Должны нам, возраст")}
              {agingLine("payable", "Мы должны, возраст")}
            </div>
            {groups.map((g) => {
              const sm = groupSummary(g);
              const isCollapsed = collapsed[g.key] ?? false;
              return (
                <div key={g.key} className="border border-border rounded-md overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setCollapsed((s) => ({ ...s, [g.key]: !isCollapsed }))}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-paper text-left"
                  >
                    <span className="flex items-center gap-2 text-[14px] font-bold text-ink">
                      <span className="text-[10px] text-muted">{isCollapsed ? "▶" : "▼"}</span>
                      {g.label}
                    </span>
                    <span className="flex items-center gap-2 flex-wrap justify-end">
                      <span className="text-[13px] text-ink font-semibold">{sm.text}</span>
                      {sm.overdue > 0 && <Chip tone="bad">просрочено {fmtMoney(sm.overdue)}</Chip>}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr>
                            <th className={thCls}>Долг</th>
                            <th className={thCls}>Дата</th>
                            <th className={thCls}>Срок</th>
                            <th className={`${thCls} text-right`}>Сумма</th>
                            <th className={`${thCls} text-right`}>Остаток</th>
                            <th className={thCls} />
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.map(({ d, rem }) => {
                            const due = d.due_date;
                            const left = due ? daysBetween(today, due) : null;
                            const myPayments = payments.filter((p) => p.debt_id === d.id);
                            const unlocked = isUnlocked(d);
                            const dir = dirOf(d);
                            return (
                              <Fragment key={d.id}>
                                <tr>
                                  <td className={tdCls}>
                                    <div className="font-semibold">{directionLabel(d)}</div>
                                    <div className="text-[12px] text-muted">
                                      {d.kind !== "store_store" && storeName(d.store)}
                                      {d.doc_number ? ` · накл. ${d.doc_number}` : ""}
                                      {d.comment ? ` · ${d.comment}` : ""}
                                    </div>
                                  </td>
                                  <td className={`${tdCls} whitespace-nowrap`}>
                                    {fmtDate(d.debt_date)}
                                    {rem > 0 && <div className="text-[11px] text-muted">{ageDays(d, today)} дн.</div>}
                                  </td>
                                  <td className={`${tdCls} whitespace-nowrap`}>
                                    {due ? fmtDate(due) : "—"}
                                    {rem > 0 && left !== null && (
                                      <div className="mt-1">
                                        {left < 0 ? <Chip tone="bad">просрочен на {-left} дн.</Chip> : left <= ref.settings.debt_alert_days ? <Chip tone="warn">через {left} дн.</Chip> : null}
                                      </div>
                                    )}
                                  </td>
                                  <td className={`${tdCls} text-right num`}>{fmtMoney(d.amount)}</td>
                                  <td className={`${tdCls} text-right num font-bold ${rem === 0 ? "text-accent" : dir === "payable" ? "text-[#A34B36]" : dir === "receivable" ? "text-accent" : ""}`}>
                                    {rem === 0 ? "закрыт" : fmtMoney(rem)}
                                  </td>
                                  <td className={`${tdCls} text-right whitespace-nowrap`}>
                                    <div className="flex gap-1.5 justify-end flex-wrap">
                                      {myPayments.length > 0 && (
                                        <button className={btnGhost} onClick={() => setShowPayments(showPayments === d.id ? null : d.id)}>
                                          Погашения ({myPayments.length})
                                        </button>
                                      )}
                                      {canEdit && rem > 0 && <button className={btnPrimary} onClick={() => setPaying(d)}>Погасить</button>}
                                      {canEdit && unlocked && (
                                        <>
                                          <button className={btnGhost} onClick={() => setEditing(d)}>Изменить</button>
                                          <button className={btnDanger} onClick={() => removeDebt(d)}>×</button>
                                        </>
                                      )}
                                      {canEdit && !unlocked && (pending.has(d.id) ? <Chip tone="warn">запрос отправлен</Chip> : <button className={btnGhost} onClick={() => setRequesting(d)}>Запросить правку</button>)}
                                    </div>
                                    {unlocked && <div className="text-[11px] text-accent mt-1">открыто до {fmtTime(d.unlock_expires_at)}</div>}
                                  </td>
                                </tr>
                                {showPayments === d.id && (
                                  <tr>
                                    <td colSpan={6} className="bg-paper px-6 py-3 border-b border-border">
                                      {myPayments.map((p) => (
                                        <div key={p.id} className="flex items-center justify-between gap-3 text-[13px] py-1">
                                          <span>
                                            {fmtDate(p.pay_date)} — {fmtMoney(p.amount)}
                                            {p.operation_id ? " · проведено в ДДС" : ""}
                                            {p.comment ? ` · ${p.comment}` : ""}
                                          </span>
                                          {canEdit && unlocked && <button className="text-[12px] text-[#A34B36]" onClick={() => removePayment(p, d)}>удалить</button>}
                                        </div>
                                      ))}
                                      {!unlocked && <div className="text-[11px] text-muted mt-1">Чтобы удалить погашение, запросите правку долга.</div>}
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {editing && (
        <DebtModal
          initial={editing}
          ref_={ref}
          stores={stores}
          byName={byName}
          describeDebt={describeDebt}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {paying && (
        <PayModal
          debt={paying}
          remaining={debtRemaining(paying, payments)}
          ref_={ref}
          storeName={storeName}
          describeDebt={describeDebt}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            load();
          }}
        />
      )}
      {requesting && (
        <RequestModal
          title="Запрос на изменение или удаление долга"
          summary={describeDebt(requesting)}
          onClose={() => setRequesting(null)}
          onSend={async (reason) => {
            const err = await createChangeRequest({
              table: "fin_debts",
              rowId: requesting.id,
              store: requesting.store,
              context: `Долг: ${describeDebt(requesting)}. Причина: ${reason}. Заявитель: ${byName}`,
            });
            if (!err) setPending((prev) => new Set(prev).add(requesting.id));
            return err;
          }}
        />
      )}
    </div>
  );
}

// ── Новый / изменить долг ──────────────────────────────────────────────────
function DebtModal({
  initial,
  ref_,
  stores,
  byName,
  describeDebt,
  onClose,
  onSaved,
}: {
  initial: Partial<FinDebt>;
  ref_: Ref;
  stores: { code: string; name: string }[];
  byName: string;
  describeDebt: (d: FinDebt) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const kind: Kind = initial.kind ?? "supplier";
  const isEdit = !!initial.id;
  const [direction, setDirection] = useState<FinDebt["direction"]>(kind === "store_store" ? "payable" : initial.direction ?? "payable");
  const [store, setStore] = useState(initial.store ?? "");
  const [otherStore, setOtherStore] = useState(initial.counterparty_store ?? "");
  const [supplierId, setSupplierId] = useState(initial.supplier_id ? String(initial.supplier_id) : "");
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : "");
  const [date, setDate] = useState(initial.debt_date ?? todayYmd());
  const [due, setDue] = useState(initial.due_date ?? "");
  const [docNumber, setDocNumber] = useState(initial.doc_number ?? "");
  const [comment, setComment] = useState(initial.comment ?? "");
  const [fromAccount, setFromAccount] = useState("");
  const [toAccount, setToAccount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = ref_.accounts.filter((a) => a.active);
  const accountsOf = (code: string): Account[] => accounts.filter((a) => a.store === code || a.store === null);

  function onSupplier(id: string) {
    setSupplierId(id);
    const terms = ref_.suppliers.find((s) => String(s.id) === id)?.payment_terms_days;
    if (terms && !due) setDue(addDays(date, terms));
  }

  async function save() {
    const amt = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!store) return setError(kind === "store_store" ? "Выберите, какой магазин должен" : "Выберите магазин");
    if (kind === "store_store" && !otherStore) return setError("Выберите, какому магазину должен");
    if (kind === "supplier" && !supplierId) return setError("Выберите поставщика");
    if (!Number.isFinite(amt) || amt <= 0) return setError("Укажите сумму");
    if (kind === "store_store" && !isEdit && !!fromAccount !== !!toAccount) return setError("Для передачи денег выберите оба счёта или оставьте оба пустыми");

    setSaving(true);
    setError(null);
    const payload = {
      kind,
      direction,
      store,
      counterparty_store: kind === "store_store" ? otherStore : null,
      supplier_id: kind === "supplier" ? Number(supplierId) : null,
      amount: amt,
      debt_date: date,
      due_date: due || null,
      doc_number: kind === "supplier" ? docNumber.trim() || null : null,
      comment: comment.trim() || null,
    };

    if (isEdit) {
      const res = await supabase.from("fin_debts").update(payload).eq("id", initial.id!);
      if (res.error) {
        setSaving(false);
        return setError(res.error.message);
      }
      const before = initial as FinDebt;
      const parts: string[] = [];
      if (before.amount !== amt) parts.push(`сумма ${fmtMoney(before.amount)} → ${fmtMoney(amt)}`);
      if (before.debt_date !== date) parts.push(`дата ${fmtDate(before.debt_date)} → ${fmtDate(date)}`);
      if ((before.due_date ?? "") !== (due || "")) parts.push(`срок ${fmtDate(before.due_date)} → ${fmtDate(due || null)}`);
      if ((before.comment ?? "") !== (comment.trim() || "") || (before.doc_number ?? "") !== (payload.doc_number ?? "")) parts.push("комментарий/накладная");
      if (parts.length) await logChange({ table: "fin_debts", rowId: before.id, store, summary: `Долг изменён (${describeDebt(before)}): ${parts.join("; ")}`, byName });
      setSaving(false);
      return onSaved();
    }

    const ins = await supabase.from("fin_debts").insert(payload).select("id").single();
    if (ins.error) {
      setSaving(false);
      return setError(ins.error.message);
    }
    const debtId = ins.data.id as number;

    // деньги, переданные другому магазину, — сразу переводом в ДДС
    if (kind === "store_store" && fromAccount && toAccount) {
      const op = await supabase
        .from("fin_operations")
        .insert({ op_date: date, kind: "transfer", amount: amt, account_id: Number(fromAccount), to_account_id: Number(toAccount), store: null, debt_id: debtId, comment: comment.trim() || "Передача денег между магазинами" })
        .select("id")
        .single();
      if (op.error) {
        setSaving(false);
        return setError(`Долг записан, но перевод в ДДС создать не удалось: ${op.error.message}. Внесите его в ДДС вручную.`);
      }
      await supabase.from("fin_debts").update({ operation_id: op.data.id }).eq("id", debtId);
    }
    setSaving(false);
    onSaved();
  }

  const accountSelect = (value: string, onChange: (v: string) => void, list: Account[]) => (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Не вносить в ДДС</option>
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
  const storeSelect = (value: string, onChange: (v: string) => void, exclude?: string) => (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Выберите…</option>
      {stores
        .filter((s) => s.code !== exclude)
        .map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
    </select>
  );

  const directionOptions: [FinDebt["direction"], string][] = [["payable", "Мы должны поставщику"], ["receivable", "Предоплата поставщику"]];

  return (
    <Modal title={`${isEdit ? "Изменить долг" : "Новый долг"} — ${KIND_LABEL[kind].toLowerCase()}`} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        {kind === "store_store" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Кто должен">{storeSelect(store, setStore, otherStore)}</Field>
            <Field label="Кому должен">{storeSelect(otherStore, setOtherStore, store)}</Field>
          </div>
        ) : (
          <>
            <div className="flex gap-1.5 bg-paper border border-border rounded-md p-1 w-fit flex-wrap">
              {directionOptions.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setDirection(k)}
                  className={`text-[13px] rounded px-4 py-1.5 ${direction === k ? "bg-accent text-paper font-bold" : "text-muted font-medium"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Field label="Магазин">{storeSelect(store, setStore)}</Field>
            <Field label="Поставщик">
              <select className={selectCls} value={supplierId} onChange={(e) => onSupplier(e.target.value)}>
                <option value="">Выберите…</option>
                {ref_.suppliers
                  .filter((s) => s.active || String(s.id) === supplierId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
          </>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Сумма, ₸">
            <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Дата долга">
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Оплатить до">
            <input type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        {kind === "supplier" && (
          <Field label="№ накладной" hint="чтобы сверять с поставщиком">
            <input className={inputCls} value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
          </Field>
        )}
        <Field label="Комментарий">
          <input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="За что долг" />
        </Field>

        {!isEdit && kind === "store_store" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Деньги переданы со счёта" hint={otherStore ? "счёт магазина-кредитора" : "сначала выберите магазины"}>
              {accountSelect(fromAccount, setFromAccount, otherStore ? accountsOf(otherStore) : [])}
            </Field>
            <Field label="на счёт" hint={store ? "счёт магазина-должника" : undefined}>
              {accountSelect(toAccount, setToAccount, store ? accountsOf(store) : [])}
            </Field>
          </div>
        )}

        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>Сохранить</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Погашение ──────────────────────────────────────────────────────────────
function PayModal({
  debt,
  remaining,
  ref_,
  storeName,
  describeDebt,
  onClose,
  onSaved,
}: {
  debt: FinDebt;
  remaining: number;
  ref_: Ref;
  storeName: (code: string | null) => string;
  describeDebt: (d: FinDebt) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isSupplierReceivable = debt.kind === "supplier" && debt.direction === "receivable";
  // предоплата поставщику закрывается либо возвратом денег, либо поставкой (без денег)
  const [mode, setMode] = useState<"cash" | "noncash">("cash");
  const [amount, setAmount] = useState(String(remaining));
  const [date, setDate] = useState(todayYmd());
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = ref_.accounts.filter((a) => a.active);
  const accountsOf = (code: string | null) => accounts.filter((a) => a.store === code || a.store === null);
  const noncash = mode === "noncash" && isSupplierReceivable;

  // что за операция создаётся в ДДС
  function operationFor(amt: number): { payload: Record<string, unknown>; missing?: string } | null {
    if (noncash) return null;
    const base = { op_date: date, amount: amt, store: debt.store, debt_id: debt.id, comment: comment.trim() || "Погашение долга" };
    if (debt.kind === "store_store") {
      return { payload: { ...base, kind: "transfer", account_id: Number(accountId), to_account_id: Number(toAccountId), store: null } };
    }
    const name = debt.direction === "payable" ? "Закуп - товар" : "Возврат от поставщика";
    const c = findCategory(ref_.categories, name);
    if (!c) return { payload: {}, missing: name };
    return { payload: { ...base, kind: debt.direction === "payable" ? "expense" : "income", account_id: Number(accountId), category_id: c.id, supplier_id: debt.supplier_id } };
  }

  async function save() {
    const amt = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) return setError("Сумма должна быть больше нуля");
    if (amt > remaining) return setError(`Сумма больше остатка долга (${fmtMoney(remaining)})`);
    if (!noncash && !accountId) return setError(debt.kind === "store_store" ? "Выберите счёт, с которого переданы деньги" : "Выберите счёт");
    if (!noncash && debt.kind === "store_store" && (!toAccountId || toAccountId === accountId)) return setError("Выберите счёт, на который переданы деньги");

    const op = operationFor(amt);
    if (op?.missing) return setError(`В «Настройки → Статьи» нет статьи «${op.missing}»`);

    setSaving(true);
    setError(null);
    let operationId: number | null = null;
    if (op) {
      const ins = await supabase.from("fin_operations").insert(op.payload).select("id").single();
      if (ins.error) {
        setSaving(false);
        return setError(ins.error.message);
      }
      operationId = ins.data.id as number;
    }
    const pay = await supabase.from("fin_debt_payments").insert({
      debt_id: debt.id,
      pay_date: date,
      amount: amt,
      operation_id: operationId,
      comment: comment.trim() || (noncash ? "Зачтено поставкой" : null),
    });
    if (pay.error) {
      if (operationId) await supabase.from("fin_operations").delete().eq("id", operationId);
      setSaving(false);
      return setError(pay.error.message);
    }
    if (amt >= remaining) await supabase.from("fin_debts").update({ closed: true }).eq("id", debt.id);
    setSaving(false);
    onSaved();
  }

  const title = debt.kind === "supplier" ? (debt.direction === "payable" ? "Оплата поставщику" : "Предоплата поставщику") : "Расчёт между магазинами";

  const accountSelect = (value: string, onChange: (v: string) => void, list: Account[]) => (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Выберите…</option>
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );

  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div className="text-[13px] text-muted">{describeDebt(debt)}. Остаток: <b className="text-ink">{fmtMoney(remaining)}</b></div>
        {isSupplierReceivable && (
          <div className="flex gap-1.5 bg-paper border border-border rounded-md p-1 w-fit flex-wrap">
            {([["cash", "Поставщик вернул деньги"], ["noncash", "Зачтено поставкой"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setMode(k)} className={`text-[13px] rounded px-4 py-1.5 ${mode === k ? "bg-accent text-paper font-bold" : "text-muted font-medium"}`}>{label}</button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Сумма, ₸">
            <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus />
          </Field>
          <Field label="Дата">
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        {!noncash && debt.kind === "store_store" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Со счёта (${storeName(debt.store)})`}>{accountSelect(accountId, setAccountId, accountsOf(debt.store))}</Field>
            <Field label={`На счёт (${storeName(debt.counterparty_store)})`}>{accountSelect(toAccountId, setToAccountId, accountsOf(debt.counterparty_store))}</Field>
          </div>
        )}
        {!noncash && debt.kind === "supplier" && (
          <Field label={isSupplierReceivable ? "На счёт" : "Со счёта"} hint="Операция появится в ДДС сама">
            {accountSelect(accountId, setAccountId, accounts)}
          </Field>
        )}
        <Field label="Комментарий">
          <input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>Провести</button>
        </div>
      </div>
    </Modal>
  );
}
