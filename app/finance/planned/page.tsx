"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { downloadExcel } from "@/lib/exportExcel";
import KpiCard from "@/components/KpiCard";
import {
  accountBalance,
  debtDirection,
  debtRemaining,
  addDays,
  categoryPath,
  daysBetween,
  fmtDate,
  fmtMoney,
  isAutoCategory,
  loadAllOperations,
  loadDebts,
  loadPlanned,
  nextDueDate,
  todayYmd,
  useFinanceRef,
  type FinDebt,
  type FinDebtPayment,
  type FinOperation,
  type FinPlanned,
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
  btnDanger,
  btnGhost,
  btnPrimary,
  inputCls,
  selectCls,
  tdCls,
  thCls,
  useSection,
} from "@/components/finance/ui";

export default function PlannedPage() {
  return (
    <FinanceGuard section="finance.planned">
      <Inner />
    </FinanceGuard>
  );
}

const REPEAT_LABEL = { none: "Разовый", weekly: "Каждую неделю", monthly: "Каждый месяц" } as const;

function Inner() {
  const ref = useFinanceRef();
  const { stores } = useAuth();
  const { selected, isAll } = useStoreSelection();
  const { canEdit } = useSection("finance.planned");
  const [items, setItems] = useState<FinPlanned[]>([]);
  const [ops, setOps] = useState<FinOperation[]>([]);
  const [debts, setDebts] = useState<FinDebt[]>([]);
  const [debtPayments, setDebtPayments] = useState<FinDebtPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"planned" | "paid" | "all">("planned");
  const [editing, setEditing] = useState<Partial<FinPlanned> | null>(null);
  const [paying, setPaying] = useState<FinPlanned | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, o, d] = await Promise.all([
        loadPlanned(),
        loadAllOperations().catch(() => [] as FinOperation[]),
        loadDebts().catch(() => ({ debts: [] as FinDebt[], payments: [] as FinDebtPayment[] })),
      ]);
      setItems(p);
      setOps(o);
      setDebts(d.debts);
      setDebtPayments(d.payments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить плановые платежи");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const today = todayYmd();
  const storeName = (code: string | null) => (code ? stores.find((s) => s.code === code)?.name ?? code : "—");
  const supplierName = (id: number | null) => ref.suppliers.find((s) => s.id === id)?.name;

  const scoped = useMemo(() => items.filter((i) => isAll || (i.store !== null && selected.includes(i.store))), [items, isAll, selected]);
  const planned = scoped.filter((i) => i.status === "planned");
  const alertDays = ref.settings.debt_alert_days;

  const overdue = planned.filter((i) => i.kind === "expense" && i.due_date < today);
  const soon = planned.filter((i) => i.kind === "expense" && i.due_date >= today && i.due_date <= addDays(today, alertDays));
  const sum = (rows: { amount: number }[]) => rows.reduce((a, r) => a + r.amount, 0);
  const next30 = planned.filter((i) => i.due_date <= addDays(today, 30));

  const list = scoped.filter((i) => (filter === "all" ? i.status !== "cancelled" : i.status === filter)).sort((a, b) => (filter === "paid" ? b.due_date.localeCompare(a.due_date) : a.due_date.localeCompare(b.due_date)));

  // Долги со сроком оплаты тоже уходят деньгами: «мы должны» — выплата, «должны нам» — приход.
  // Долги без срока в прогноз не попадают (сроков нет — неизвестно когда).
  const debtItems = useMemo(() => {
    const out: { due_date: string; kind: "income" | "expense"; amount: number }[] = [];
    for (const d of debts) {
      if (!d.due_date) continue;
      if (!(isAll || selected.includes(d.store) || (d.counterparty_store !== null && selected.includes(d.counterparty_store)))) continue;
      const rem = debtRemaining(d, debtPayments);
      const dir = debtDirection(d, isAll, selected);
      // предоплата поставщику закрывается товаром, а не деньгами — в прогноз не входит
      if (rem <= 0 || !dir || (d.kind === "supplier" && d.direction === "receivable")) continue;
      out.push({ due_date: d.due_date, kind: dir === "payable" ? "expense" : "income", amount: rem });
    }
    return out;
  }, [debts, debtPayments, isAll, selected]);
  const cashItems = useMemo(() => [...planned.map((i) => ({ due_date: i.due_date, kind: i.kind, amount: i.amount })), ...debtItems], [planned, debtItems]);

  // прогноз остатка по неделям: сегодняшний остаток + плановые приходы − плановые расходы
  const forecast = useMemo(() => {
    const accounts = ref.accounts.filter((a) => a.active && (isAll || (a.store !== null && selected.includes(a.store))));
    let bal = accounts.reduce((a, acc) => a + accountBalance(acc, ops, today), 0);
    const weeks: { from: string; to: string; income: number; expense: number; end: number }[] = [];
    for (let w = 0; w < 8; w++) {
      const from = addDays(today, w * 7);
      const to = addDays(today, w * 7 + 6);
      // просроченные платежи падают в первую неделю
      const inWeek = cashItems.filter((i) => (w === 0 ? i.due_date <= to : i.due_date >= from && i.due_date <= to));
      const income = sum(inWeek.filter((i) => i.kind === "income"));
      const expense = sum(inWeek.filter((i) => i.kind === "expense"));
      bal += income - expense;
      weeks.push({ from, to, income, expense, end: bal });
    }
    return { start: accounts.reduce((a, acc) => a + accountBalance(acc, ops, today), 0), weeks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.accounts, ops, cashItems, isAll, selected, today]);
  const firstGap = forecast.weeks.find((w) => w.end < 0);

  async function cancel(i: FinPlanned) {
    if (!confirm("Отменить этот плановый платёж?")) return;
    const { error: e } = await supabase.from("fin_planned_payments").update({ status: "cancelled" }).eq("id", i.id);
    if (e) setError(e.message);
    load();
  }
  async function remove(i: FinPlanned) {
    if (!confirm("Удалить плановый платёж?")) return;
    const { error: e } = await supabase.from("fin_planned_payments").delete().eq("id", i.id);
    if (e) setError(e.message);
    load();
  }

  function exportXls() {
    downloadExcel(
      "Плановые_платежи",
      ["Срок", "Тип", "Статья", "Магазин", "Контрагент", "Сумма", "Повтор", "Статус", "Комментарий"],
      list.map((i) => [fmtDate(i.due_date), i.kind === "income" ? "Приход" : "Расход", categoryPath(ref.categories, i.category_id), storeName(i.store), supplierName(i.supplier_id) ?? "", i.amount, REPEAT_LABEL[i.repeat], i.status === "paid" ? "оплачен" : "ожидает", i.comment ?? ""])
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="Плановые платежи"
        subtitle="Будущие оплаты и ожидаемые поступления: аренда, зарплата, налоги, поставщики. По ним строится прогноз остатка денег — видно заранее, где не хватит."
      />
      <ErrorBox message={error ?? ref.error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard label="Просрочено" value={fmtMoney(sum(overdue))} valueTone={overdue.length ? "negative" : "neutral"} note={`${overdue.length} шт.`} />
        <KpiCard label={`Ближайшие ${alertDays} дн.`} value={fmtMoney(sum(soon))} valueTone={soon.length ? "warning" : "neutral"} note={`${soon.length} шт.`} />
        <KpiCard label="Платежей на 30 дней" value={fmtMoney(sum(next30.filter((i) => i.kind === "expense")))} note={`ожидаем прихода: ${fmtMoney(sum(next30.filter((i) => i.kind === "income")))}`} />
        <KpiCard
          label="Кассовый разрыв"
          value={firstGap ? `с ${fmtDate(firstGap.from)}` : "не ожидается"}
          valueTone={firstGap ? "negative" : "positive"}
          note={firstGap ? `остаток ${fmtMoney(firstGap.end)}` : "на 8 недель вперёд"}
          noteTone={firstGap ? "negative" : "neutral"}
        />
      </div>

      <Card title="Прогноз остатка денег на 8 недель" right={<span className="text-[12px] text-muted">сейчас на счетах: {fmtMoney(forecast.start)}</span>}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse min-w-[520px]">
            <thead>
              <tr>
                <th className={thCls}>Неделя</th>
                <th className={`${thCls} text-right`}>Приход</th>
                <th className={`${thCls} text-right`}>Выплаты</th>
                <th className={`${thCls} text-right`}>Остаток на конец</th>
              </tr>
            </thead>
            <tbody>
              {forecast.weeks.map((w, idx) => (
                <tr key={w.from}>
                  <td className={tdCls}>{fmtDate(w.from)} — {fmtDate(w.to)}{idx === 0 && <span className="text-[11px] text-muted ml-2">(с просроченными)</span>}</td>
                  <td className={`${tdCls} text-right num text-accent`}>{w.income ? fmtMoney(w.income) : "—"}</td>
                  <td className={`${tdCls} text-right num text-[#A34B36]`}>{w.expense ? fmtMoney(w.expense) : "—"}</td>
                  <td className={`${tdCls} text-right num font-bold ${w.end < 0 ? "text-[#A34B36]" : ""}`}>{fmtMoney(w.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-muted mt-3">В прогноз входят остаток на счетах, плановые платежи и долги со сроком оплаты (мы должны — выплата, должны нам — приход). Будущая выручка от продаж не учитывается — это «запас прочности» без новых продаж.</p>
      </Card>

      <Card
        title="Платежи"
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex gap-1 bg-paper border border-border rounded-md p-1">
              {([["planned", "Ожидают"], ["paid", "Оплачены"], ["all", "Все"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setFilter(k)} className={`text-[12px] rounded px-3 py-1 ${filter === k ? "bg-accent text-paper font-bold" : "text-muted font-medium"}`}>{l}</button>
              ))}
            </div>
            <button className={btnGhost} onClick={exportXls}>Скачать Excel</button>
            {canEdit && <button className={btnPrimary} onClick={() => setEditing({ due_date: addDays(today, 1), kind: "expense", repeat: "none" })}>+ Платёж</button>}
          </div>
        }
      >
        {loading ? (
          <Empty>Загрузка…</Empty>
        ) : list.length === 0 ? (
          <Empty>Платежей нет</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>Срок</th>
                  <th className={thCls}>Статья</th>
                  <th className={thCls}>Магазин</th>
                  <th className={thCls}>Контрагент / комментарий</th>
                  <th className={thCls}>Повтор</th>
                  <th className={`${thCls} text-right`}>Сумма</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {list.map((i) => {
                  const left = daysBetween(today, i.due_date);
                  return (
                    <tr key={i.id}>
                      <td className={`${tdCls} whitespace-nowrap`}>
                        {fmtDate(i.due_date)}
                        <div className="mt-1">
                          {i.status === "paid" ? <Chip tone="ok">оплачен</Chip> : left < 0 ? <Chip tone="bad">просрочен на {-left} дн.</Chip> : left === 0 ? <Chip tone="warn">сегодня</Chip> : left <= alertDays ? <Chip tone="warn">через {left} дн.</Chip> : null}
                        </div>
                      </td>
                      <td className={tdCls}>{categoryPath(ref.categories, i.category_id)}</td>
                      <td className={tdCls}>{storeName(i.store)}</td>
                      <td className={tdCls}>
                        {supplierName(i.supplier_id)}
                        {i.comment && <div className="text-[12px] text-muted">{i.comment}</div>}
                      </td>
                      <td className={tdCls}>{REPEAT_LABEL[i.repeat]}</td>
                      <td className={`${tdCls} text-right num font-semibold whitespace-nowrap ${i.kind === "income" ? "text-accent" : "text-[#A34B36]"}`}>
                        {i.kind === "income" ? "+" : "−"}{fmtMoney(i.amount)}
                      </td>
                      <td className={`${tdCls} text-right whitespace-nowrap`}>
                        {canEdit && i.status === "planned" && (
                          <div className="flex gap-1.5 justify-end">
                            <button className={btnPrimary} onClick={() => setPaying(i)}>{i.kind === "income" ? "Получено" : "Оплатить"}</button>
                            <button className={btnGhost} onClick={() => setEditing(i)}>Изменить</button>
                            <button className={btnGhost} onClick={() => cancel(i)}>Отменить</button>
                          </div>
                        )}
                        {canEdit && i.status !== "planned" && <button className={btnDanger} onClick={() => remove(i)}>×</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <PlannedModal initial={editing} ref_={ref} stores={stores} defaultStore="" onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {paying && <PayModal item={paying} ref_={ref} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); load(); }} />}
    </div>
  );
}

function PlannedModal({
  initial,
  ref_,
  stores,
  defaultStore,
  onClose,
  onSaved,
}: {
  initial: Partial<FinPlanned>;
  ref_: ReturnType<typeof useFinanceRef>;
  stores: { code: string; name: string }[];
  defaultStore: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<FinPlanned["kind"]>(initial.kind ?? "expense");
  const [due, setDue] = useState(initial.due_date ?? todayYmd());
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : "");
  const [categoryId, setCategoryId] = useState(initial.category_id ? String(initial.category_id) : "");
  const [store, setStore] = useState(initial.store ?? (initial.id ? "" : defaultStore));
  const [supplierId, setSupplierId] = useState(initial.supplier_id ? String(initial.supplier_id) : "");
  const [accountId, setAccountId] = useState(initial.account_id ? String(initial.account_id) : "");
  const [repeat, setRepeat] = useState<FinPlanned["repeat"]>(initial.repeat ?? "none");
  const [comment, setComment] = useState(initial.comment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needSupplier = kind === "expense" && !!ref_.categories.find((c) => String(c.id) === categoryId)?.require_supplier;
  const cats = ref_.categories.filter((c) => c.kind === kind && ((c.active && !isAutoCategory(c, ref_.settings)) || String(c.id) === categoryId));
  const tops = cats.filter((c) => c.parent_id === null);

  async function save() {
    const amt = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) return setError("Сумма должна быть больше нуля");
    if (!categoryId) return setError("Выберите статью");
    if (needSupplier && !supplierId) return setError("Для этой статьи выберите поставщика");
    // у старых платежей «без магазина» можно сохранять как есть, у новых магазин обязателен
    if (!store && !(initial.id && initial.store === null)) return setError("Выберите магазин");
    setSaving(true);
    const payload = {
      due_date: due,
      kind,
      amount: amt,
      category_id: Number(categoryId),
      store: store || null,
      supplier_id: needSupplier && supplierId ? Number(supplierId) : null,
      account_id: accountId ? Number(accountId) : null,
      repeat,
      comment: comment.trim() || null,
    };
    const res = initial.id ? await supabase.from("fin_planned_payments").update(payload).eq("id", initial.id) : await supabase.from("fin_planned_payments").insert(payload);
    setSaving(false);
    if (res.error) return setError(res.error.message);
    onSaved();
  }

  return (
    <Modal title={initial.id ? "Изменить плановый платёж" : "Новый плановый платёж"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div className="flex gap-1.5 bg-paper border border-border rounded-md p-1 w-fit">
          {([["expense", "Выплата"], ["income", "Поступление"]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => { setKind(k); setCategoryId(""); }} className={`text-[13px] rounded px-4 py-1.5 ${kind === k ? "bg-accent text-paper font-bold" : "text-muted font-medium"}`}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Срок"><input type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Сумма, ₸"><input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus /></Field>
        </div>
        <CategorySelect categories={cats} value={categoryId} onChange={setCategoryId} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Магазин"><select className={selectCls} value={store} onChange={(e) => setStore(e.target.value)}><option value="">Выберите…</option>{stores.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></Field>
          <Field label="Счёт"><select className={selectCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Определить при оплате</option>{ref_.accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        </div>
        {needSupplier && (
          <Field label="Поставщик">
            <select className={selectCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Выберите…</option>
              {ref_.suppliers.filter((s) => s.active || String(s.id) === supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Повтор" hint="После оплаты автоматически создаётся следующий платёж">
          <select className={selectCls} value={repeat} onChange={(e) => setRepeat(e.target.value as FinPlanned["repeat"])}>
            {(Object.keys(REPEAT_LABEL) as FinPlanned["repeat"][]).map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}
          </select>
        </Field>
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

// Оплата: создаёт операцию в ДДС, помечает платёж оплаченным и, если он
// повторяющийся, создаёт следующий.
function PayModal({ item, ref_, onClose, onSaved }: { item: FinPlanned; ref_: ReturnType<typeof useFinanceRef>; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayYmd());
  const [amount, setAmount] = useState(String(item.amount));
  const [accountId, setAccountId] = useState(item.account_id ? String(item.account_id) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const amt = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) return setError("Сумма должна быть больше нуля");
    if (!accountId) return setError("Выберите счёт");
    setSaving(true);
    setError(null);
    const op = await supabase
      .from("fin_operations")
      .insert({
        op_date: date,
        kind: item.kind,
        amount: amt,
        account_id: Number(accountId),
        category_id: item.category_id,
        store: item.store,
        supplier_id: item.supplier_id,
        comment: item.comment,
      })
      .select("id")
      .single();
    if (op.error) {
      setSaving(false);
      return setError(op.error.message);
    }
    const upd = await supabase.from("fin_planned_payments").update({ status: "paid", operation_id: op.data.id, account_id: Number(accountId) }).eq("id", item.id);
    if (upd.error) {
      await supabase.from("fin_operations").delete().eq("id", op.data.id);
      setSaving(false);
      return setError(upd.error.message);
    }
    const next = nextDueDate(item.due_date, item.repeat);
    if (next) {
      await supabase.from("fin_planned_payments").insert({
        due_date: next,
        kind: item.kind,
        amount: item.amount,
        category_id: item.category_id,
        store: item.store,
        supplier_id: item.supplier_id,
        account_id: item.account_id,
        repeat: item.repeat,
        comment: item.comment,
      });
    }
    setSaving(false);
    onSaved();
  }

  return (
    <Modal title={item.kind === "income" ? "Поступление получено" : "Оплата платежа"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div className="text-[13px] text-muted">В ДДС будет создана операция по статье «{categoryPath(ref_.categories, item.category_id)}».{item.repeat !== "none" && " Следующий платёж создастся автоматически."}</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Фактическая сумма, ₸"><input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus /></Field>
          <Field label="Дата"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label={item.kind === "income" ? "На счёт" : "Со счёта"}>
          <select className={selectCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Выберите…</option>
            {ref_.accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
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
