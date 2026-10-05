"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import {
  ACCOUNT_KIND_LABEL,
  OPIU_GROUP_LABEL,
  fmtMoney,
  fmtDate,
  todayYmd,
  useFinanceRef,
  type FinAccount,
  type FinCategory,
  type FinPartner,
  type FinSupplier,
  type OpiuGroup,
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

type Tab = "categories" | "accounts" | "partners" | "suppliers" | "terms";

export default function FinanceSettingsPage() {
  return (
    <FinanceGuard section="finance.settings">
      <Inner />
    </FinanceGuard>
  );
}

function Inner() {
  const ref = useFinanceRef();
  const { canEdit } = useSection("finance.settings");
  const [tab, setTab] = useState<Tab>("categories");

  return (
    <div>
      <PageTitle
        title="Настройки финансов"
        subtitle="Справочники, из которых собираются ДДС, ОПИУ, долги и плановые платежи. Статьи — с пунктом и подпунктом."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "categories", label: "Статьи" },
          { key: "accounts", label: "Счета" },
          { key: "partners", label: "Партнёры" },
          { key: "suppliers", label: "Поставщики" },
          { key: "terms", label: "Условия" },
        ]}
      />
      <ErrorBox message={ref.error} />
      {tab === "categories" && <CategoriesTab categories={ref.categories} canEdit={canEdit} reload={ref.reload} />}
      {tab === "accounts" && <AccountsTab accounts={ref.accounts} canEdit={canEdit} reload={ref.reload} />}
      {tab === "partners" && <PartnersTab partners={ref.partners} canEdit={canEdit} reload={ref.reload} />}
      {tab === "suppliers" && <SuppliersTab suppliers={ref.suppliers} canEdit={canEdit} reload={ref.reload} />}
      {tab === "terms" && !ref.loading && <TermsTab key={JSON.stringify(ref.settings)} settings={ref.settings} canEdit={canEdit} reload={ref.reload} />}
    </div>
  );
}

// ── Статьи ─────────────────────────────────────────────────────────────────
function CategoriesTab({ categories, canEdit, reload }: { categories: FinCategory[]; canEdit: boolean; reload: () => void }) {
  const [editing, setEditing] = useState<{ cat: Partial<FinCategory>; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tops = categories.filter((c) => c.parent_id === null);

  // Поменять статью местами с соседней (в пределах одного пункта): порядок
  // пересчитывается у всех «соседей», чтобы не зависеть от прежних номеров.
  async function move(c: FinCategory, dir: -1 | 1) {
    setError(null);
    const siblings = categories
      .filter((x) => x.parent_id === c.parent_id)
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
    const i = siblings.findIndex((x) => x.id === c.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    const results = await Promise.all(
      siblings.map((x, idx) => (x.sort === (idx + 1) * 10 ? null : supabase.from("fin_categories").update({ sort: (idx + 1) * 10 }).eq("id", x.id)))
    );
    const failed = results.find((r) => r && r.error);
    if (failed?.error) setError(failed.error.message);
    reload();
  }
  const siblingsOf = (c: FinCategory) => categories.filter((x) => x.parent_id === c.parent_id).sort((a, b) => a.sort - b.sort || a.id - b.id);

  async function toggleActive(c: FinCategory) {
    setError(null);
    const { error: e } = await supabase.from("fin_categories").update({ active: !c.active }).eq("id", c.id);
    if (e) setError(e.message);
    reload();
  }
  async function remove(c: FinCategory) {
    if (!confirm(`Удалить статью «${c.name}»? Если по ней уже есть операции, удалить не получится — её можно скрыть.`)) return;
    setError(null);
    const { error: e } = await supabase.from("fin_categories").delete().eq("id", c.id);
    if (e) setError(e.code === "23503" ? "По статье уже есть данные или подпункты — скройте её вместо удаления." : e.message);
    reload();
  }

  function row(c: FinCategory, level: 0 | 1) {
    return (
      <tr key={c.id} className={c.active ? "" : "opacity-50"}>
        <td className={`${tdCls} whitespace-nowrap ${level === 1 ? "pl-9" : "font-semibold"}`}>
          {level === 1 ? "└ " : ""}
          {c.name}
        </td>
        <td className={tdCls}>{c.kind === "income" ? "Доход" : "Расход"}</td>
        <td className={tdCls}>
          {c.opiu_group ? OPIU_GROUP_LABEL[c.opiu_group] : <Chip tone="muted">не входит в ОПИУ</Chip>}
          {c.auto_tax && <span className="ml-2"><Chip tone="ok">считается автоматически</Chip></span>}
          {c.require_supplier && <span className="ml-2"><Chip tone="muted">с выбором поставщика</Chip></span>}
        </td>
        <td className={`${tdCls} text-right whitespace-nowrap`}>
          {canEdit && (
            <div className="flex gap-1.5 justify-end">
              <button className={btnGhost} title="Выше" disabled={siblingsOf(c)[0]?.id === c.id} onClick={() => move(c, -1)}>▲</button>
              <button className={btnGhost} title="Ниже" disabled={siblingsOf(c).slice(-1)[0]?.id === c.id} onClick={() => move(c, 1)}>▼</button>
              {level === 0 ? (
                <button className={`${btnGhost} w-[112px]`} onClick={() => setEditing({ cat: { parent_id: c.id, kind: c.kind, opiu_group: c.opiu_group, active: true }, isNew: true })}>
                  + подпункт
                </button>
              ) : (
                <span className="w-[112px]" />
              )}
              <button className={`${btnGhost} w-[92px]`} onClick={() => setEditing({ cat: c, isNew: false })}>
                Изменить
              </button>
            </div>
          )}
        </td>
      </tr>
    );
  }

  return (
    <Card
      title="Статьи доходов и расходов"
      right={canEdit ? <button className={btnPrimary} onClick={() => setEditing({ cat: { kind: "expense", opiu_group: "marketing", active: true }, isNew: true })}>+ Пункт</button> : undefined}
    >
      <ErrorBox message={error} />
      <p className="text-[12px] text-muted mb-3">
        «Группа ОПИУ» определяет, где статья окажется в отчёте о прибылях и убытках. Статьи без группы (закупка товара, взносы партнёров, займы,
        оборудование) двигают деньги, но прибылью не считаются. Выручка и себестоимость при включённой автозагрузке берутся из МойСклад.
      </p>
      {tops.length === 0 ? (
        <Empty>Статей пока нет</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>Статья</th>
                <th className={thCls}>Тип</th>
                <th className={thCls}>Группа в ОПИУ</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {tops.map((t) => [row(t, 0), ...categories.filter((c) => c.parent_id === t.id).map((c) => row(c, 1))])}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <CategoryModal
          initial={editing.cat}
          isNew={editing.isNew}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onToggleActive={editing.isNew ? undefined : async () => { await toggleActive(editing.cat as FinCategory); setEditing(null); }}
          onDelete={editing.isNew ? undefined : async () => { await remove(editing.cat as FinCategory); setEditing(null); }}
        />
      )}
    </Card>
  );
}

function CategoryModal({
  initial,
  isNew,
  categories,
  onClose,
  onSaved,
  onToggleActive,
  onDelete,
}: {
  initial: Partial<FinCategory>;
  isNew: boolean;
  categories: FinCategory[];
  onClose: () => void;
  onSaved: () => void;
  onToggleActive?: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [kind, setKind] = useState<"income" | "expense">(initial.kind ?? "expense");
  const [requireSupplier, setRequireSupplier] = useState(!!initial.require_supplier);
  const [group, setGroup] = useState<OpiuGroup | "none">(initial.opiu_group ?? (initial.opiu_group === null || initial.parent_id ? "none" : "marketing"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parent = initial.parent_id ? categories.find((c) => c.id === initial.parent_id) : null;

  const groups = Object.keys(OPIU_GROUP_LABEL) as OpiuGroup[];
  const inherited = !!initial.parent_id; // у подпункта показатель такой же, как у пункта

  async function save() {
    if (!name.trim()) return setError("Укажите название");
    setSaving(true);
    setError(null);
    const payload = { name: name.trim(), kind, opiu_group: group === "none" ? null : group, require_supplier: kind === "expense" && requireSupplier };
    const res = isNew
      ? await supabase.from("fin_categories").insert({ ...payload, parent_id: initial.parent_id ?? null, sort: Math.max(0, ...categories.filter((c) => c.parent_id === (initial.parent_id ?? null)).map((c) => c.sort)) + 10 })
      : await supabase.from("fin_categories").update(payload).eq("id", initial.id!);
    // подпункты всегда в той же группе ОПИУ, что и их пункт
    if (!res.error && !isNew && initial.parent_id == null) {
      const kids = await supabase.from("fin_categories").update({ opiu_group: payload.opiu_group }).eq("parent_id", initial.id!);
      if (kids.error) {
        setSaving(false);
        return setError(kids.error.message);
      }
    }
    setSaving(false);
    if (res.error) return setError(res.error.message);
    onSaved();
  }

  return (
    <Modal title={isNew ? (parent ? `Подпункт к «${parent.name}»` : "Новый пункт") : "Изменить статью"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <Field label="Название">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Тип">
          <select
            className={selectCls}
            value={kind}
            onChange={(e) => {
              const k = e.target.value as "income" | "expense";
              setKind(k);
              if (!inherited) setGroup(k === "income" ? "other_income" : "marketing");
            }}
          >
            <option value="expense">Расход</option>
            <option value="income">Доход</option>
          </select>
        </Field>
        <Field label="Группа в ОПИУ" hint="«Не входит в ОПИУ» — для движения капитала: закупка товара, займы, взносы партнёров, оборудование.">
          <select className={selectCls} value={group} onChange={(e) => setGroup(e.target.value as OpiuGroup | "none")} disabled={inherited}>
            {groups.map((g) => (
              <option key={g} value={g}>
                {OPIU_GROUP_LABEL[g]}
              </option>
            ))}
            <option value="none">Не входит в ОПИУ</option>
          </select>
        </Field>
        {kind === "expense" && (
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={requireSupplier} onChange={(e) => setRequireSupplier(e.target.checked)} />
            При внесении обязательно выбирать поставщика
          </label>
        )}
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-between items-center flex-wrap">
          <div className="flex gap-2">
            {onToggleActive && <button className={btnGhost} onClick={onToggleActive}>{initial.active ? "Скрыть" : "Вернуть"}</button>}
            {onDelete && <button className={btnDanger} onClick={onDelete}>Удалить</button>}
          </div>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={onClose}>Отмена</button>
            <button className={btnPrimary} onClick={save} disabled={saving}>Сохранить</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Счета ──────────────────────────────────────────────────────────────────
function AccountsTab({ accounts, canEdit, reload }: { accounts: FinAccount[]; canEdit: boolean; reload: () => void }) {
  const { stores } = useAuth();
  const [editing, setEditing] = useState<Partial<FinAccount> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(a: FinAccount) {
    const { error: e } = await supabase.from("fin_accounts").update({ active: !a.active }).eq("id", a.id);
    if (e) setError(e.message);
    reload();
  }
  async function remove(a: FinAccount) {
    if (!confirm(`Удалить счёт «${a.name}»? Если по нему есть операции, удалить не получится — счёт можно скрыть.`)) return;
    const { error: e } = await supabase.from("fin_accounts").delete().eq("id", a.id);
    if (e) setError(e.code === "23503" ? "По счёту уже есть операции — скройте его вместо удаления." : e.message);
    reload();
  }

  return (
    <Card title="Счета и кассы" right={canEdit ? <button className={btnPrimary} onClick={() => setEditing({ kind: "cash", opening_balance: 0, opening_date: todayYmd(), active: true })}>+ Счёт</button> : undefined}>
      <ErrorBox message={error} />
      {accounts.length === 0 ? (
        <Empty>Счетов пока нет. Добавьте кассы магазинов и расчётные счета — остатки считаются от «начального остатка».</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thCls}>Название</th>
                <th className={thCls}>Вид</th>
                <th className={thCls}>Магазин</th>
                <th className={`${thCls} text-right`}>Начальный остаток</th>
                <th className={thCls}>На дату</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className={a.active ? "" : "opacity-50"}>
                  <td className={`${tdCls} font-semibold`}>{a.name}</td>
                  <td className={tdCls}>{ACCOUNT_KIND_LABEL[a.kind]}</td>
                  <td className={tdCls}>{a.store ? stores.find((s) => s.code === a.store)?.name ?? a.store : "Общий"}</td>
                  <td className={`${tdCls} text-right num`}>{fmtMoney(a.opening_balance)}</td>
                  <td className={tdCls}>{fmtDate(a.opening_date)}</td>
                  <td className={`${tdCls} text-right`}>
                    {canEdit && (
                      <div className="flex gap-1.5 justify-end">
                        <button className={btnGhost} onClick={() => setEditing(a)}>Изменить</button>
                        <button className={btnGhost} onClick={() => toggle(a)}>{a.active ? "Скрыть" : "Вернуть"}</button>
                        <button className={btnDanger} onClick={() => remove(a)}>Удалить</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <AccountModal initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </Card>
  );
}

function AccountModal({ initial, onClose, onSaved }: { initial: Partial<FinAccount>; onClose: () => void; onSaved: () => void }) {
  const { stores } = useAuth();
  const [name, setName] = useState(initial.name ?? "");
  const [kind, setKind] = useState<FinAccount["kind"]>(initial.kind ?? "cash");
  const [store, setStore] = useState(initial.store ?? "");
  const [balance, setBalance] = useState(String(initial.opening_balance ?? 0));
  const [date, setDate] = useState(initial.opening_date ?? todayYmd());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("Укажите название");
    const bal = Number(balance.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(bal)) return setError("Начальный остаток — число");
    setSaving(true);
    const payload = { name: name.trim(), kind, store: store || null, opening_balance: bal, opening_date: date };
    const res = initial.id
      ? await supabase.from("fin_accounts").update(payload).eq("id", initial.id)
      : await supabase.from("fin_accounts").insert(payload);
    setSaving(false);
    if (res.error) return setError(res.error.message);
    onSaved();
  }

  return (
    <Modal title={initial.id ? "Изменить счёт" : "Новый счёт"} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <Field label="Название"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Касса Актау" autoFocus /></Field>
        <Field label="Вид">
          <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as FinAccount["kind"])}>
            {(Object.keys(ACCOUNT_KIND_LABEL) as FinAccount["kind"][]).map((k) => <option key={k} value={k}>{ACCOUNT_KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Магазин" hint="Пусто — общий счёт компании">
          <select className={selectCls} value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">Общий</option>
            {stores.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Начальный остаток, ₸"><input className={inputCls} value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" /></Field>
          <Field label="На дату"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>Сохранить</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Партнёры ───────────────────────────────────────────────────────────────
function PartnersTab({ partners, canEdit, reload }: { partners: FinPartner[]; canEdit: boolean; reload: () => void }) {
  const [editing, setEditing] = useState<Partial<FinPartner> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(p: FinPartner) {
    const { error: e } = await supabase.from("fin_partners").update({ active: !p.active }).eq("id", p.id);
    if (e) setError(e.message);
    reload();
  }
  async function remove(p: FinPartner) {
    if (!confirm(`Удалить партнёра «${p.name}»?`)) return;
    const { error: e } = await supabase.from("fin_partners").delete().eq("id", p.id);
    if (e) setError(e.code === "23503" ? "У партнёра есть долги или операции — скройте его вместо удаления." : e.message);
    reload();
  }

  return (
    <Card title="Партнёры" right={canEdit ? <button className={btnPrimary} onClick={() => setEditing({ active: true })}>+ Партнёр</button> : undefined}>
      <ErrorBox message={error} />
      {partners.length === 0 ? (
        <Empty>Партнёров пока нет</Empty>
      ) : (
        <table className="w-full border-collapse">
          <thead><tr><th className={thCls}>Имя</th><th className={thCls}>Телефон</th><th className={thCls}>Заметка</th><th className={thCls} /></tr></thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                <td className={`${tdCls} font-semibold`}>{p.name}</td>
                <td className={tdCls}>{p.phone ?? "—"}</td>
                <td className={tdCls}>{p.note ?? "—"}</td>
                <td className={`${tdCls} text-right`}>
                  {canEdit && (
                    <div className="flex gap-1.5 justify-end">
                      <button className={btnGhost} onClick={() => setEditing(p)}>Изменить</button>
                      <button className={btnGhost} onClick={() => toggle(p)}>{p.active ? "Скрыть" : "Вернуть"}</button>
                      <button className={btnDanger} onClick={() => remove(p)}>Удалить</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <SimpleModal table="fin_partners" title={editing.id ? "Изменить партнёра" : "Новый партнёр"} initial={editing} withTerms={false} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </Card>
  );
}

// ── Поставщики ─────────────────────────────────────────────────────────────
function SuppliersTab({ suppliers, canEdit, reload }: { suppliers: FinSupplier[]; canEdit: boolean; reload: () => void }) {
  const [editing, setEditing] = useState<Partial<FinSupplier> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(s: FinSupplier) {
    const { error: e } = await supabase.from("fin_suppliers").update({ active: !s.active }).eq("id", s.id);
    if (e) setError(e.message);
    reload();
  }
  async function remove(s: FinSupplier) {
    if (!confirm(`Удалить поставщика «${s.name}»?`)) return;
    const { error: e } = await supabase.from("fin_suppliers").delete().eq("id", s.id);
    if (e) setError(e.code === "23503" ? "У поставщика есть долги или операции — скройте его вместо удаления." : e.message);
    reload();
  }

  return (
    <Card title="Поставщики" right={canEdit ? <button className={btnPrimary} onClick={() => setEditing({ active: true })}>+ Поставщик</button> : undefined}>
      <ErrorBox message={error} />
      {suppliers.length === 0 ? (
        <Empty>Поставщиков пока нет</Empty>
      ) : (
        <table className="w-full border-collapse">
          <thead><tr><th className={thCls}>Название</th><th className={thCls}>БИН</th><th className={thCls}>Телефон</th><th className={thCls}>Отсрочка, дней</th><th className={thCls}>Заметка</th><th className={thCls} /></tr></thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id} className={s.active ? "" : "opacity-50"}>
                <td className={`${tdCls} font-semibold`}>{s.name}</td>
                <td className={tdCls}>{s.bin ?? "—"}</td>
                <td className={tdCls}>{s.phone ?? "—"}</td>
                <td className={tdCls}>{s.payment_terms_days ?? "—"}</td>
                <td className={tdCls}>{s.note ?? "—"}</td>
                <td className={`${tdCls} text-right`}>
                  {canEdit && (
                    <div className="flex gap-1.5 justify-end">
                      <button className={btnGhost} onClick={() => setEditing(s)}>Изменить</button>
                      <button className={btnGhost} onClick={() => toggle(s)}>{s.active ? "Скрыть" : "Вернуть"}</button>
                      <button className={btnDanger} onClick={() => remove(s)}>Удалить</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <SimpleModal table="fin_suppliers" title={editing.id ? "Изменить поставщика" : "Новый поставщик"} initial={editing} withTerms onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </Card>
  );
}

function SimpleModal({
  table,
  title,
  initial,
  withTerms,
  onClose,
  onSaved,
}: {
  table: "fin_partners" | "fin_suppliers";
  title: string;
  initial: Partial<FinPartner & FinSupplier>;
  withTerms: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [bin, setBin] = useState(initial.bin ?? "");
  const [terms, setTerms] = useState(initial.payment_terms_days ? String(initial.payment_terms_days) : "");
  const [note, setNote] = useState(initial.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("Укажите название");
    setSaving(true);
    const payload: Record<string, unknown> = { name: name.trim(), phone: phone.trim() || null, note: note.trim() || null };
    if (withTerms) {
      payload.bin = bin.trim() || null;
      payload.payment_terms_days = terms ? Number(terms) : null;
    }
    const res = initial.id ? await supabase.from(table).update(payload).eq("id", initial.id) : await supabase.from(table).insert(payload);
    setSaving(false);
    if (res.error) return setError(res.error.message);
    onSaved();
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <Field label="Название / имя"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Телефон"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        {withTerms && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="БИН / ИИН"><input className={inputCls} value={bin} onChange={(e) => setBin(e.target.value)} /></Field>
            <Field label="Отсрочка платежа, дней" hint="Срок долга считается от даты долга"><input className={inputCls} value={terms} onChange={(e) => setTerms(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /></Field>
          </div>
        )}
        <Field label="Заметка"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>Сохранить</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Условия ────────────────────────────────────────────────────────────────
function TermsTab({ settings, canEdit, reload }: { settings: ReturnType<typeof useFinanceRef>["settings"]; canEdit: boolean; reload: () => void }) {
  const [autoRevenue, setAutoRevenue] = useState(settings.auto_revenue);
  const [autoCogs, setAutoCogs] = useState(settings.auto_cogs);
  const [autoTax, setAutoTax] = useState(settings.auto_tax);
  const [taxRate, setTaxRate] = useState(String(settings.tax_rate));
  const [alertDays, setAlertDays] = useState(String(settings.debt_alert_days));
  const [lowBalance, setLowBalance] = useState(String(settings.low_balance_limit));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setMsg(null);
    const rows = [
      { key: "auto_revenue", value: autoRevenue },
      { key: "auto_cogs", value: autoCogs },
      { key: "auto_tax", value: autoTax },
      { key: "tax_rate", value: Number(taxRate.replace(",", ".")) || 0 },
      { key: "debt_alert_days", value: Number(alertDays) || 0 },
      { key: "low_balance_limit", value: Number(lowBalance.replace(/\s/g, "").replace(",", ".")) || 0 },
    ].map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    const { error: e } = await supabase.from("fin_settings").upsert(rows, { onConflict: "key" });
    setSaving(false);
    if (e) return setError(e.message);
    setMsg("Сохранено");
    reload();
  }

  const row = "flex items-start gap-3 py-3 border-b border-border";
  return (
    <Card title="Условия ведения финансов">
      <div className="max-w-2xl">
        <label className={row}>
          <input type="checkbox" className="mt-1" checked={autoRevenue} onChange={(e) => setAutoRevenue(e.target.checked)} disabled={!canEdit} />
          <span>
            <span className="text-[13px] font-semibold text-ink block">Выручка в ОПИУ — автоматически из МойСклад</span>
            <span className="text-[12px] text-muted">Продажи по кассам за период, без дублирования ручными операциями. Если выключить — выручка считается по доходным операциям из ДДС.</span>
          </span>
        </label>
        <label className={row}>
          <input type="checkbox" className="mt-1" checked={autoCogs} onChange={(e) => setAutoCogs(e.target.checked)} disabled={!canEdit} />
          <span>
            <span className="text-[13px] font-semibold text-ink block">Себестоимость в ОПИУ — автоматически из МойСклад</span>
            <span className="text-[12px] text-muted">Себестоимость проданных товаров по учёту МойСклад. Закупка товара у поставщиков в ОПИУ не попадает — это движение денег, а не расход.</span>
          </span>
        </label>
        <div className={row}>
          <input type="checkbox" className="mt-1" checked={autoTax} onChange={(e) => setAutoTax(e.target.checked)} disabled={!canEdit} />
          <div className="flex-1">
            <span className="text-[13px] font-semibold text-ink block">Налог «3%» считать автоматически</span>
            <span className="text-[12px] text-muted block mb-2">В ОПИУ статья налога = процент от безналичных поступлений выручки в ДДС (счета вида «расчётный счёт» и «карта»). Наличные не учитываются; вручную вносить этот налог не нужно.</span>
            <div className="flex items-center gap-2">
              <input className={`${inputCls} max-w-[90px]`} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} disabled={!canEdit} inputMode="decimal" />
              <span className="text-[13px] text-muted">% ставка</span>
            </div>
          </div>
        </div>
        <div className={row}>
          <div className="flex-1">
            <div className="text-[13px] font-semibold text-ink">Предупреждать о сроках за, дней</div>
            <div className="text-[12px] text-muted mb-2">Долги и плановые платежи со сроком ближе этого числа попадают в «Требует внимания» на обзоре.</div>
            <input className={`${inputCls} max-w-[140px]`} value={alertDays} onChange={(e) => setAlertDays(e.target.value.replace(/\D/g, ""))} disabled={!canEdit} inputMode="numeric" />
          </div>
        </div>
        <div className={row}>
          <div className="flex-1">
            <div className="text-[13px] font-semibold text-ink">Минимальный остаток на счёте, ₸</div>
            <div className="text-[12px] text-muted mb-2">Если остаток счёта ниже этой суммы — предупреждение на обзоре. 0 — предупреждать только об отрицательном остатке.</div>
            <input className={`${inputCls} max-w-[200px]`} value={lowBalance} onChange={(e) => setLowBalance(e.target.value)} disabled={!canEdit} inputMode="decimal" />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          {canEdit && <button className={btnPrimary} onClick={save} disabled={saving}>Сохранить</button>}
          {msg && <span className="text-[13px] text-accent">{msg}</span>}
        </div>
        <div className="mt-3"><ErrorBox message={error} /></div>
      </div>
    </Card>
  );
}
