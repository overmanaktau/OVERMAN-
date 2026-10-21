"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { daysBetween, fmtDate, fmtMoney, todayYmd } from "@/lib/finance";
import { Card, Chip, Empty, ErrorBox, Field, Modal, PageTitle, btnDanger, btnGhost, btnPrimary, inputCls, selectCls, tdCls, thCls, useSection } from "@/components/finance/ui";

// «Оплаты»: постоянные расходы (услуги, лицензии) и срок, до которого оплачено. Ближайшие сроки сверху.
type Service = { id: number; name: string; pay_to: string | null; amount: number | null; store: string | null; paid_until: string; comment: string | null };

const SOON_DAYS = 30; // за столько дней до конца срока оплата выделяется как «скоро»

export default function PaymentsPage() {
  const { ready, canView } = useSection("settings.payments");
  if (!ready) return null;
  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Оплаты».</p>
      </div>
    );
  }
  return <Inner />;
}

function Inner() {
  const { stores } = useAuth();
  const { canEdit } = useSection("settings.payments");
  const [items, setItems] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Service> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.from("pay_services").select("*").order("paid_until");
    if (err) setError(err.message);
    else setItems(((data ?? []) as Service[]).map((x) => ({ ...x, amount: x.amount === null ? null : Number(x.amount) })));
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const today = todayYmd();

  async function remove(item: Service) {
    if (!window.confirm(`Удалить «${item.name}» из списка оплат?`)) return;
    const { error: err } = await supabase.from("pay_services").delete().eq("id", item.id);
    if (err) setError(err.message);
    else load();
  }

  // По городам: сначала каждый магазин, в конце — общие для всех
  const groups = [
    ...stores.map((st) => ({ key: st.code, label: st.name, rows: items.filter((x) => x.store === st.code) })),
    { key: "__all__", label: "Все магазины", rows: items.filter((x) => x.store === null) },
  ].filter((g) => g.rows.length > 0);

  return (
    <>
      <PageTitle
        title="Оплаты"
        subtitle="Услуги и лицензии, которые нужно оплачивать постоянно, и срок, до которого оплачено. Ближайшие сроки — сверху."
        actions={canEdit ? <button className={btnPrimary} onClick={() => setEditing({ paid_until: today })}>+ Оплата</button> : undefined}
      />
      <ErrorBox message={error} />
      {loading ? (
        <Card title="Что и куда оплачивать">
          <Empty>Загрузка…</Empty>
        </Card>
      ) : groups.length === 0 ? (
        <Card title="Что и куда оплачивать">
          <Empty>Пока ничего не добавлено</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <Card key={g.key} title={g.label}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={thCls}>Что оплачивать</th>
                      <th className={thCls}>Куда платить</th>
                      <th className={`${thCls} text-right`}>Сумма</th>
                      <th className={thCls}>Оплачено до</th>
                      <th className={thCls}>Осталось</th>
                      <th className={thCls} />
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((i) => {
                      const left = daysBetween(today, i.paid_until);
                      return (
                        <tr key={i.id}>
                          <td className={`${tdCls} font-medium`}>
                            {i.name}
                            {i.comment && <div className="text-[12px] text-muted font-normal">{i.comment}</div>}
                          </td>
                          <td className={tdCls}>{i.pay_to || "—"}</td>
                          <td className={`${tdCls} text-right num`}>{i.amount === null ? "—" : fmtMoney(i.amount)}</td>
                          <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(i.paid_until)}</td>
                          <td className={tdCls}>
                            <Chip tone={left < 0 ? "bad" : left <= SOON_DAYS ? "warn" : "muted"}>{left < 0 ? `просрочено на ${-left} дн.` : left === 0 ? "сегодня" : `${left} дн.`}</Chip>
                          </td>
                          <td className={`${tdCls} whitespace-nowrap text-right`}>
                            {canEdit && (
                              <div className="flex gap-2 justify-end">
                                <button className={btnGhost} onClick={() => setEditing(i)}>Изменить</button>
                                <button className={btnDanger} onClick={() => remove(i)}>Удалить</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <EditModal
          initial={editing}
          stores={stores}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function EditModal({ initial, stores, onClose, onSaved }: { initial: Partial<Service>; stores: { code: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial.name ?? "");
  const [payTo, setPayTo] = useState(initial.pay_to ?? "");
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount) : "");
  const [store, setStore] = useState(initial.store ?? "");
  const [paidUntil, setPaidUntil] = useState(initial.paid_until ?? todayYmd());
  const [comment, setComment] = useState(initial.comment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("Напишите, что оплачивать");
    if (!paidUntil) return setError("Укажите срок: до какого числа оплачено");
    const amt = amount.trim() ? Number(amount.replace(/\s/g, "").replace(",", ".")) : null;
    if (amt !== null && (!Number.isFinite(amt) || amt < 0)) return setError("Сумма указана неверно");
    setSaving(true);
    const payload = { name: name.trim(), pay_to: payTo.trim() || null, amount: amt, store: store || null, paid_until: paidUntil, comment: comment.trim() || null };
    const res = initial.id ? await supabase.from("pay_services").update(payload).eq("id", initial.id) : await supabase.from("pay_services").insert(payload);
    setSaving(false);
    if (res.error) return setError(res.error.message);
    onSaved();
  }

  return (
    <Modal title={initial.id ? "Изменить оплату" : "Новая оплата"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <Field label="Что оплачивать"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Wi-Fi, лицензия МойСклад" autoFocus /></Field>
        <Field label="Куда платить"><input className={inputCls} value={payTo} onChange={(e) => setPayTo(e.target.value)} placeholder="Кому или где оплачивать" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Оплачено до"><input type="date" className={inputCls} value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} /></Field>
          <Field label="Сумма, ₸"><input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
        </div>
        <Field label="Магазин">
          <select className={selectCls} value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">Все магазины</option>
            {stores.map((s) => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
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
