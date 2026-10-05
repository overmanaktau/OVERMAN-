"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { downloadExcel } from "@/lib/exportExcel";
import KpiCard from "@/components/KpiCard";
import {
  addDays,
  daysBetween,
  debtRemaining,
  fmtDate,
  fmtMoney,
  loadDebts,
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
  partner: "Партнёры ↔ магазины",
};

function Inner() {
  const ref = useFinanceRef();
  const { stores } = useAuth();
  const { selected, isAll } = useStoreSelection();
  const { canEdit } = useSection("finance.debts");
  const [kind, setKind] = useState<Kind>("store_store");
  const [debts, setDebts] = useState<FinDebt[]>([]);
  const [payments, setPayments] = useState<FinDebtPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<Partial<FinDebt> | null>(null);
  const [paying, setPaying] = useState<FinDebt | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await loadDebts();
      setDebts(r.debts);
      setPayments(r.payments);
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
    const kinds: Kind[] = ["store_store", "supplier", "partner"];
    const first = kinds.find((k) => debts.some((d) => d.kind === k && debtRemaining(d, payments) > 0));
    if (first) setKind(first);
  }, [tabPicked, loading, debts, payments]);

  const storeName = (code: string | null) => (code ? stores.find((s) => s.code === code)?.name ?? code : "—");
  const supplierName = (id: number | null) => ref.suppliers.find((s) => s.id === id)?.name ?? "—";
  const partnerName = (id: number | null) => ref.partners.find((p) => p.id === id)?.name ?? "—";
  const today = todayYmd();

  const scoped = useMemo(
    () => debts.filter((d) => isAll || selected.includes(d.store) || (d.counterparty_store !== null && selected.includes(d.counterparty_store))),
    [debts, isAll, selected]
  );
  const withRemaining = useMemo(() => scoped.map((d) => ({ d, rem: debtRemaining(d, payments) })), [scoped, payments]);
  const open = withRemaining.filter((x) => x.rem > 0);

  const sum = (rows: typeof open, dir: FinDebt["direction"]) => rows.filter((x) => x.d.direction === dir).reduce((a, x) => a + x.rem, 0);
  const weOwe = sum(open, "payable");
  const owedToUs = sum(open, "receivable");
  const overdue = open.filter((x) => x.d.due_date && x.d.due_date < today);
  const overdueSum = overdue.filter((x) => x.d.direction === "payable").reduce((a, x) => a + x.rem, 0);

  const list = withRemaining
    .filter((x) => x.d.kind === kind && (showClosed || x.rem > 0))
    .sort((a, b) => (a.d.due_date ?? "9999").localeCompare(b.d.due_date ?? "9999"));

  function counterparty(d: FinDebt): string {
    if (d.kind === "store_store") return storeName(d.counterparty_store);
    if (d.kind === "supplier") return supplierName(d.supplier_id);
    return partnerName(d.partner_id);
  }
  function directionLabel(d: FinDebt): string {
    if (d.kind === "store_store") return d.direction === "payable" ? `${storeName(d.store)} должен` : `${storeName(d.store)} должны`;
    return d.direction === "payable" ? "Мы должны" : "Нам должны";
  }

  async function removeDebt(d: FinDebt) {
    if (!confirm("Удалить долг вместе с историей погашений? Операции в ДДС останутся.")) return;
    const { error: e } = await supabase.from("fin_debts").delete().eq("id", d.id);
    if (e) setError(e.message);
    load();
  }
  async function removePayment(p: FinDebtPayment) {
    if (!confirm(`Удалить погашение ${fmtMoney(p.amount)}? Связанная операция в ДДС тоже будет удалена.`)) return;
    if (p.operation_id) await supabase.from("fin_operations").delete().eq("id", p.operation_id);
    const { error: e } = await supabase.from("fin_debt_payments").delete().eq("id", p.id);
    if (e) setError(e.message);
    load();
  }

  function exportXls() {
    downloadExcel(
      "Долги",
      ["Вид", "Направление", "Магазин", "Контрагент", "Дата долга", "Срок", "Сумма долга", "Погашено", "Остаток", "Комментарий"],
      withRemaining
        .filter((x) => x.rem > 0)
        .map(({ d, rem }) => [KIND_LABEL[d.kind], directionLabel(d), storeName(d.store), counterparty(d), fmtDate(d.debt_date), fmtDate(d.due_date), d.amount, d.amount - rem, rem, d.comment ?? ""])
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="Долги"
        subtitle="Что должны мы и что должны нам: между магазинами, поставщикам и партнёрам. Остаток считается по погашениям; погашение можно сразу провести в ДДС."
        actions={
          <>
            <button className={btnGhost} onClick={exportXls}>Скачать Excel</button>
            {canEdit && <button className={btnPrimary} onClick={() => setEditing({ kind, direction: "payable", debt_date: todayYmd(), store: !isAll && selected.length === 1 ? selected[0] : "" })}>+ Долг</button>}
          </>
        }
      />
      <ErrorBox message={error ?? ref.error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Мы должны" value={fmtMoney(weOwe)} valueTone={weOwe > 0 ? "warning" : "neutral"} />
        <KpiCard label="Нам должны" value={fmtMoney(owedToUs)} valueTone="positive" />
        <KpiCard label="Баланс долгов" value={fmtMoney(owedToUs - weOwe)} valueTone={owedToUs - weOwe < 0 ? "negative" : "positive"} note="нам должны − мы должны" />
        <KpiCard label="Просрочено нами" value={fmtMoney(overdueSum)} valueTone={overdueSum > 0 ? "negative" : "neutral"} note={overdue.length ? `${overdue.length} шт. с просроченным сроком` : "просрочек нет"} noteTone={overdue.length ? "negative" : "neutral"} />
      </div>

      <Tabs value={kind} onChange={setKind} items={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ key: k, label: `${KIND_LABEL[k]} (${open.filter((x) => x.d.kind === k).length})` }))} />

      <Card
        title={KIND_LABEL[kind]}
        right={
          <label className="flex items-center gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> показывать закрытые
          </label>
        }
      >
        {loading ? (
          <Empty>Загрузка…</Empty>
        ) : list.length === 0 ? (
          <Empty>Долгов нет</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>Направление</th>
                  <th className={thCls}>Контрагент</th>
                  <th className={thCls}>Дата</th>
                  <th className={thCls}>Срок</th>
                  <th className={`${thCls} text-right`}>Сумма</th>
                  <th className={`${thCls} text-right`}>Остаток</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {list.map(({ d, rem }) => {
                  const due = d.due_date;
                  const left = due ? daysBetween(today, due) : null;
                  const alertDays = ref.settings.debt_alert_days;
                  const myPayments = payments.filter((p) => p.debt_id === d.id);
                  return (
                    <Fragment key={d.id}>
                      <tr>
                        <td className={tdCls}>
                          <div className="font-semibold">{directionLabel(d)}</div>
                          {d.kind !== "store_store" && <div className="text-[12px] text-muted">{storeName(d.store)}</div>}
                        </td>
                        <td className={tdCls}>
                          {counterparty(d)}
                          {d.comment && <div className="text-[12px] text-muted">{d.comment}</div>}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(d.debt_date)}</td>
                        <td className={`${tdCls} whitespace-nowrap`}>
                          {due ? fmtDate(due) : "—"}
                          {rem > 0 && left !== null && (
                            <div className="mt-1">
                              {left < 0 ? <Chip tone="bad">просрочен на {-left} дн.</Chip> : left <= alertDays ? <Chip tone="warn">через {left} дн.</Chip> : null}
                            </div>
                          )}
                        </td>
                        <td className={`${tdCls} text-right num`}>{fmtMoney(d.amount)}</td>
                        <td className={`${tdCls} text-right num font-bold ${rem === 0 ? "text-accent" : d.direction === "payable" ? "text-[#A34B36]" : "text-accent"}`}>
                          {rem === 0 ? "закрыт" : fmtMoney(rem)}
                        </td>
                        <td className={`${tdCls} text-right whitespace-nowrap`}>
                          <div className="flex gap-1.5 justify-end">
                            {myPayments.length > 0 && (
                              <button className={btnGhost} onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                                Погашения ({myPayments.length})
                              </button>
                            )}
                            {canEdit && rem > 0 && <button className={btnPrimary} onClick={() => setPaying(d)}>Погасить</button>}
                            {canEdit && <button className={btnGhost} onClick={() => setEditing(d)}>Изменить</button>}
                            {canEdit && <button className={btnDanger} onClick={() => removeDebt(d)}>×</button>}
                          </div>
                        </td>
                      </tr>
                      {expanded === d.id && (
                        <tr key={`${d.id}-p`}>
                          <td colSpan={7} className="bg-paper px-6 py-3 border-b border-border">
                            {myPayments.map((p) => (
                              <div key={p.id} className="flex items-center justify-between gap-3 text-[13px] py-1">
                                <span>{fmtDate(p.pay_date)} — {fmtMoney(p.amount)}{p.operation_id ? " · проведено в ДДС" : ""}{p.comment ? ` · ${p.comment}` : ""}</span>
                                {canEdit && <button className="text-[12px] text-[#A34B36]" onClick={() => removePayment(p)}>удалить</button>}
                              </div>
                            ))}
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
      </Card>

      {editing && (
        <DebtModal
          initial={editing}
          ref_={ref}
          stores={stores}
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
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function DebtModal({
  initial,
  ref_,
  stores,
  onClose,
  onSaved,
}: {
  initial: Partial<FinDebt>;
  ref_: ReturnType<typeof useFinanceRef>;
  stores: { code: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<Kind>(initial.kind ?? "store_store");
  const [direction, setDirection] = useState<FinDebt["direction"]>(initial.direction ?? "payable");
  const [store, setStore] = useState(initial.store ?? "");
  const [otherStore, setOtherStore] = useState(initial.counterparty_store ?? "");
  const [supplierId, setSupplierId] = useState(initial.supplier_id ? String(initial.supplier_id) : "");
  const [partnerId, setPartnerId] = useState(initial.partner_id ? String(initial.partner_id) : "");
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : "");
  const [date, setDate] = useState(initial.debt_date ?? todayYmd());
  const [due, setDue] = useState(initial.due_date ?? "");
  const [comment, setComment] = useState(initial.comment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSupplier(id: string) {
    setSupplierId(id);
    const terms = ref_.suppliers.find((s) => String(s.id) === id)?.payment_terms_days;
    if (terms && !due) setDue(addDays(date, terms));
  }

  async function save() {
    const amt = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) return setError("Сумма должна быть больше нуля");
    if (!store) return setError("Выберите магазин");
    if (kind === "store_store" && (!otherStore || otherStore === store)) return setError("Выберите второй магазин");
    if (kind === "supplier" && !supplierId) return setError("Выберите поставщика");
    if (kind === "partner" && !partnerId) return setError("Выберите партнёра");
    setSaving(true);
    const payload = {
      kind,
      direction,
      store,
      counterparty_store: kind === "store_store" ? otherStore : null,
      supplier_id: kind === "supplier" ? Number(supplierId) : null,
      partner_id: kind === "partner" ? Number(partnerId) : null,
      amount: amt,
      debt_date: date,
      due_date: due || null,
      comment: comment.trim() || null,
    };
    const res = initial.id ? await supabase.from("fin_debts").update(payload).eq("id", initial.id) : await supabase.from("fin_debts").insert(payload);
    setSaving(false);
    if (res.error) return setError(res.error.message);
    onSaved();
  }

  const storeLabel = kind === "store_store" ? (direction === "payable" ? "Магазин-должник" : "Магазин-кредитор") : "Магазин";
  return (
    <Modal title={initial.id ? "Изменить долг" : "Новый долг"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <Field label="Вид">
          <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as Kind)} disabled={!!initial.id}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Направление">
          <select className={selectCls} value={direction} onChange={(e) => setDirection(e.target.value as FinDebt["direction"])}>
            {kind === "store_store" ? (
              <>
                <option value="payable">Первый магазин должен второму</option>
                <option value="receivable">Второй магазин должен первому</option>
              </>
            ) : (
              <>
                <option value="payable">Магазин должен {kind === "supplier" ? "поставщику" : "партнёру"}</option>
                <option value="receivable">{kind === "supplier" ? "Поставщик" : "Партнёр"} должен магазину</option>
              </>
            )}
          </select>
        </Field>
        <div className={kind === "store_store" ? "grid grid-cols-2 gap-3" : ""}>
          <Field label={kind === "store_store" ? "Первый магазин" : storeLabel}>
            <select className={selectCls} value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">Выберите…</option>
              {stores.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </Field>
          {kind === "store_store" && (
            <Field label="Второй магазин">
              <select className={selectCls} value={otherStore} onChange={(e) => setOtherStore(e.target.value)}>
                <option value="">Выберите…</option>
                {stores.filter((s) => s.code !== store).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        {kind === "supplier" && (
          <Field label="Поставщик">
            <select className={selectCls} value={supplierId} onChange={(e) => onSupplier(e.target.value)}>
              <option value="">Выберите…</option>
              {ref_.suppliers.filter((s) => s.active || String(s.id) === supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}
        {kind === "partner" && (
          <Field label="Партнёр">
            <select className={selectCls} value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
              <option value="">Выберите…</option>
              {ref_.partners.filter((p) => p.active || String(p.id) === partnerId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Сумма, ₸"><input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Дата долга"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Срок оплаты"><input type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        </div>
        <Field label="Комментарий"><input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Накладная, договор, за что долг" /></Field>
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>Сохранить</button>
        </div>
      </div>
    </Modal>
  );
}

function PayModal({
  debt,
  remaining,
  ref_,
  onClose,
  onSaved,
}: {
  debt: FinDebt;
  remaining: number;
  ref_: ReturnType<typeof useFinanceRef>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(String(remaining));
  const [date, setDate] = useState(todayYmd());
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = debt.direction === "payable" ? "expense" : "income";
  const cats = ref_.categories.filter((c) => c.kind === kind && c.active);
  const withAccount = debt.kind !== "store_store" || accountId !== "";

  async function save() {
    const amt = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) return setError("Сумма должна быть больше нуля");
    if (amt > remaining) return setError(`Сумма больше остатка долга (${fmtMoney(remaining)})`);
    setSaving(true);
    setError(null);
    let operationId: number | null = null;
    if (accountId) {
      const op = await supabase
        .from("fin_operations")
        .insert({
          op_date: date,
          kind,
          amount: amt,
          account_id: Number(accountId),
          category_id: categoryId ? Number(categoryId) : null,
          store: debt.store,
          supplier_id: debt.supplier_id,
          partner_id: debt.partner_id,
          debt_id: debt.id,
          comment: comment.trim() || "Погашение долга",
        })
        .select("id")
        .single();
      if (op.error) {
        setSaving(false);
        return setError(op.error.message);
      }
      operationId = op.data.id as number;
    }
    const pay = await supabase.from("fin_debt_payments").insert({ debt_id: debt.id, pay_date: date, amount: amt, operation_id: operationId, comment: comment.trim() || null });
    if (pay.error) {
      if (operationId) await supabase.from("fin_operations").delete().eq("id", operationId);
      setSaving(false);
      return setError(pay.error.message);
    }
    if (amt >= remaining) await supabase.from("fin_debts").update({ closed: true }).eq("id", debt.id);
    setSaving(false);
    onSaved();
  }

  return (
    <Modal title={debt.direction === "payable" ? "Погашение долга" : "Получение долга"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div className="text-[13px] text-muted">Остаток долга: <b className="text-ink">{fmtMoney(remaining)}</b></div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Сумма, ₸"><input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus /></Field>
          <Field label="Дата"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label={kind === "expense" ? "Со счёта" : "На счёт"} hint={debt.kind === "store_store" ? "Для расчётов между своими магазинами счёт можно не указывать — в ДДС ничего не попадёт" : "Укажите счёт, чтобы погашение появилось в ДДС"}>
          <select className={selectCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{debt.kind === "store_store" ? "Не проводить в ДДС" : "Не проводить в ДДС (только отметить)"}</option>
            {ref_.accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        {withAccount && accountId && (
          <Field label="Статья в ДДС" hint="Для поставщиков — «Закупка товара», для партнёров — «Взнос/выплата партнёру»">
            <select className={selectCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Без статьи (погашение долга)</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.parent_id ? "   " : ""}{c.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Комментарий"><input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>Провести</button>
        </div>
      </div>
    </Modal>
  );
}
