"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import type { SectionKey } from "@/lib/permissions";
import { PERIOD_LABELS, type FinCategory, type PeriodPreset } from "@/lib/finance";

export const inputCls =
  "text-[13px] bg-paper border border-border rounded-md px-2.5 py-2 text-ink placeholder:text-mutedLight focus:outline-none focus:border-accent w-full";
export const selectCls = inputCls;
export const btnPrimary =
  "text-[13px] font-bold bg-accent text-paper rounded-md px-4 py-2 hover:opacity-90 disabled:opacity-50";
export const btnGhost =
  "text-[13px] font-medium text-muted border border-border rounded-md px-3.5 py-2 hover:text-ink hover:bg-paper disabled:opacity-50";
export const btnDanger =
  "text-[13px] font-medium text-[#A34B36] border border-[#E4C9C0] rounded-md px-3.5 py-2 hover:bg-[#FBF2EF] disabled:opacity-50";
export const thCls = "text-left text-[11px] uppercase tracking-wide text-muted font-semibold px-3 py-2 border-b border-border whitespace-nowrap";
export const tdCls = "px-3 py-2.5 border-b border-border text-[13px] text-ink align-top";

// Доступ к странице по разделу прав; возвращает canEdit для кнопок.
export function useSection(section: SectionKey) {
  const { isAdmin, permissions, role } = useAuth();
  const p = permissions[section];
  return {
    ready: role !== null,
    canView: isAdmin || !!p?.canView,
    canEdit: isAdmin || !!p?.canEdit,
  };
}

export function FinanceGuard({ section, children }: { section: SectionKey; children: React.ReactNode }) {
  const { ready, canView } = useSection(section);
  if (!ready) return null;
  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к этому разделу «Финансов».</p>
      </div>
    );
  }
  return <>{children}</>;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
      <div>
        <h1 className="font-serif text-[26px] font-semibold text-ink leading-tight">{title}</h1>
        {subtitle && <p className="text-[13px] text-muted mt-1 max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function PeriodTabs({
  preset,
  onPreset,
  from,
  onFrom,
  to,
  onTo,
  allowed,
}: {
  preset: PeriodPreset;
  onPreset: (p: PeriodPreset) => void;
  from: string;
  onFrom: (v: string) => void;
  to: string;
  onTo: (v: string) => void;
  allowed?: PeriodPreset[];
}) {
  const items = PERIOD_LABELS.filter((p) => !allowed || allowed.includes(p.key));
  return (
    <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit flex-wrap">
      {items.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onPreset(p.key)}
          className={`text-[13px] rounded-md px-3.5 py-2 ${preset === p.key ? "bg-accent text-paper font-bold" : "text-muted font-medium"}`}
        >
          {p.label}
        </button>
      ))}
      {preset === "custom" && (
        <div className="flex items-center gap-1.5 pl-2 ml-1 border-l border-border">
          <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className="text-[13px] bg-paper border border-border rounded-md px-2 py-1.5" />
          <span className="text-muted text-xs">—</span>
          <input type="date" value={to} onChange={(e) => onTo(e.target.value)} className="text-[13px] bg-paper border border-border rounded-md px-2 py-1.5" />
        </div>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string }[] }) {
  return (
    <div className="flex items-center gap-1 border-b border-border mb-5 flex-wrap">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={`text-[13px] px-4 py-2.5 -mb-px border-b-2 ${
            value === it.key ? "border-accent text-ink font-bold" : "border-transparent text-muted font-medium hover:text-ink"
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, right, children, className }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border border-border rounded-card px-6 py-5 ${className ?? ""}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 mb-3.5">
          <div className="text-[15px] font-bold text-ink">{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 overflow-y-auto">
      <div
        className="min-h-full flex items-center justify-center p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
      <div className={`bg-surface border border-border rounded-card w-full ${wide ? "max-w-3xl" : "max-w-lg"} p-6`}>
        <div className="flex items-center justify-between mb-4">
          <div className="font-serif text-[20px] font-semibold text-ink">{title}</div>
          <button type="button" onClick={onClose} className="text-muted hover:text-ink text-xl leading-none px-2">
            ×
          </button>
        </div>
        {children}
      </div>
      </div>
    </div>
  );
}

// Статья в два шага: сначала пункт, потом подпункт (если он есть) — вместо одного
// длинного списка. Возвращает id статьи, а пока подпункт не выбран — пустую строку.
export function CategorySelect({
  categories,
  value,
  onChange,
  label = "Статья",
}: {
  categories: FinCategory[];
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  const tops = categories.filter((c) => c.parent_id === null);
  const current = categories.find((c) => String(c.id) === value);
  const [top, setTop] = useState(current ? String(current.parent_id ?? current.id) : "");

  useEffect(() => {
    if (current) setTop(String(current.parent_id ?? current.id));
    else if (!value && top && !tops.some((t) => String(t.id) === top)) setTop("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, categories]);

  const kids = top ? categories.filter((c) => String(c.parent_id) === top) : [];

  function pickTop(t: string) {
    setTop(t);
    const hasKids = categories.some((c) => String(c.parent_id) === t);
    onChange(t && !hasKids ? t : "");
  }

  return (
    <div className="flex flex-col gap-3.5">
      <Field label={label}>
        <select className={selectCls} value={top} onChange={(e) => pickTop(e.target.value)}>
          <option value="">Выберите…</option>
          {tops.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      {kids.length > 0 && (
        <Field label="Подпункт">
          <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Выберите…</option>
            {kids.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

// Окно запроса на правку или удаление: коротко пишем причину, запрос уходит в «Запросы».
export function RequestModal({
  title,
  summary,
  onClose,
  onSend,
}: {
  title: string;
  summary: string;
  onClose: () => void;
  onSend: (reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!reason.trim()) return setError("Напишите, что и почему нужно изменить");
    setSending(true);
    setError(null);
    const err = await onSend(reason.trim());
    setSending(false);
    if (err) return setError(err);
    onClose();
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div className="text-[13px] text-muted bg-paper border border-border rounded-md px-3 py-2">{summary}</div>
        <Field label="Что изменить или почему удалить" hint="Запрос увидит владелец в разделе «Запросы». После одобрения запись открывается на 30 минут.">
          <textarea className={`${inputCls} min-h-[84px]`} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        <ErrorBox message={error} />
        <div className="flex gap-2 justify-end">
          <button className={btnGhost} onClick={onClose}>Отмена</button>
          <button className={btnPrimary} onClick={send} disabled={sending}>Отправить запрос</button>
        </div>
      </div>
    </Modal>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-mutedLight">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="text-[13px] text-[#A34B36] bg-[#FBF2EF] border border-[#E4C9C0] rounded-md px-3 py-2">{message}</div>;
}

export function Chip({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  const cls = {
    ok: "text-accent bg-[#EAF1EA] border-[#CFE0CF]",
    warn: "text-[#B8752E] bg-[#FBF3E6] border-[#EBD7B5]",
    bad: "text-[#A34B36] bg-[#FBF2EF] border-[#E4C9C0]",
    muted: "text-muted bg-paper border-border",
  }[tone];
  return <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 whitespace-nowrap ${cls}`}>{children}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] text-muted py-6 text-center">{children}</div>;
}
