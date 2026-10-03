"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { getErrorMessage } from "@/lib/errors";

type DayRow = {
  id?: number;
  entryDate: string; // "YYYY-MM-DD" — ключ в базе
  date: string; // "DD.MM" — только для показа
  weekday: string;
  weekend: boolean;
  plan: number | "";
  // Был ли план уже внесён: первый раз — свободно на любую дату, а изменить
  // внесённый можно только по одобренному запросу (как у плана трафика).
  planEverEntered: boolean;
  requestPending: boolean;
  unlockExpiresAt: string | null;
};

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]; // как у Date#getDay()
const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function ymd(year: number, monthIndex: number, day: number) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}
function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}
function minutesLeft(iso: string, nowMs: number) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / 60000));
}

// Цифры и одна запятая-разделитель (точка тоже печатается как запятая), до двух
// знаков после неё — применяется на каждом изменении, чтобы вставка из буфера
// не принесла ничего лишнего.
function sanitizeAmountText(raw: string): string {
  let s = raw.replace(/\./g, ",").replace(/[^\d,]/g, "");
  const firstComma = s.indexOf(",");
  if (firstComma !== -1) {
    const intPart = s.slice(0, firstComma);
    const decPart = s.slice(firstComma + 1).replace(/,/g, "").slice(0, 2);
    s = `${intPart},${decPart}`;
  }
  return s;
}
function parseAmountText(text: string): number | "" {
  if (text === "" || text === ",") return "";
  const n = Number(text.replace(",", "."));
  return Number.isNaN(n) ? "" : n;
}
function formatGrouped(n: number | ""): string {
  if (n === "") return "";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}
function amountKeyDown(currentText: string) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey) return;
    const allowed = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (allowed.includes(e.key)) return;
    if ((e.key === "," || e.key === ".") && !currentText.includes(",")) return;
    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
  };
}

function buildMonthRows(year: number, monthIndex: number): DayRow[] {
  const rows: DayRow[] = [];
  for (let d = 1; d <= daysInMonth(year, monthIndex); d++) {
    const weekday = WEEKDAYS[new Date(year, monthIndex, d).getDay()];
    rows.push({
      entryDate: ymd(year, monthIndex, d),
      date: `${pad2(d)}.${pad2(monthIndex + 1)}`,
      weekday,
      weekend: weekday === "Сб" || weekday === "Вс",
      plan: "",
      planEverEntered: false,
      requestPending: false,
      unlockExpiresAt: null,
    });
  }
  return rows;
}

// Внесение плана продаж по датам (страница «Продажа»). Вносится отдельно на
// каждую дату и каждую точку, как трафик в «Внесении данных» маркетинга:
// первый раз — свободно, любая дата; изменить внесённый — только по
// одобренному запросу (30 минут на правку после одобрения).
export function SalesPlanEntry({ onSaved }: { onSaved?: () => void }) {
  const { isAdmin, permissions, stores, accessibleStoreCodes, fullName, email } = useAuth();
  const canEdit = isAdmin || permissions["sales.plan"].canEdit;
  const requesterLabel = fullName || email || "Пользователь";
  const accessibleStores = stores.filter((s) => accessibleStoreCodes.includes(s.code));

  const [store, setStore] = useState("");
  useEffect(() => {
    if (!store && accessibleStores.length > 0) setStore(accessibleStores[0].code);
    else if (store && !accessibleStoreCodes.includes(store) && accessibleStores.length > 0) {
      setStore(accessibleStores[0].code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessibleStoreCodes.join(",")]);
  const storeName = stores.find((s) => s.code === store)?.name ?? store;

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIndex, setMonthIndex] = useState(today.getMonth());

  const [rows, setRows] = useState<DayRow[]>([]);
  const [originalRows, setOriginalRows] = useState<DayRow[]>([]);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  function rowIsExpired(unlockExpiresAt: string | null) {
    return !!unlockExpiresAt && new Date(unlockExpiresAt).getTime() <= nowTick;
  }
  // Уже внесённый план закрыт, пока нет действующего (не истёкшего) окна
  // после одобренного запроса.
  function planLocked(row: DayRow) {
    if (!row.planEverEntered) return false;
    return !row.unlockExpiresAt || rowIsExpired(row.unlockExpiresAt);
  }

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);
    try {
      const firstStr = ymd(year, monthIndex, 1);
      const lastStr = ymd(year, monthIndex, daysInMonth(year, monthIndex));
      const [entriesRes, requestsRes] = await Promise.all([
        supabase.from("sales_plan_entries").select("*").eq("store", store).gte("entry_date", firstStr).lte("entry_date", lastStr),
        supabase
          .from("edit_requests")
          .select("entry_date")
          .eq("table_name", "sales_plan_entries")
          .eq("status", "pending")
          .eq("store", store)
          .gte("entry_date", firstStr)
          .lte("entry_date", lastStr),
      ]);
      if (entriesRes.error) throw entriesRes.error;
      if (requestsRes.error) throw requestsRes.error;

      const pendingDates = new Set((requestsRes.data ?? []).map((r) => r.entry_date));
      const byDate = new Map((entriesRes.data ?? []).map((e) => [e.entry_date, e]));
      const merged = buildMonthRows(year, monthIndex).map((row) => {
        const db = byDate.get(row.entryDate);
        if (!db) return { ...row, requestPending: pendingDates.has(row.entryDate) };
        return {
          ...row,
          id: db.id,
          plan: db.sales_plan ?? "",
          planEverEntered: db.sales_plan !== null,
          requestPending: pendingDates.has(row.entryDate),
          unlockExpiresAt: db.unlock_expires_at ?? null,
        } as DayRow;
      });
      setRows(merged);
      setOriginalRows(merged);
    } catch (e) {
      setError(`Не удалось загрузить план: ${getErrorMessage(e)}`);
      const empty = buildMonthRows(year, monthIndex);
      setRows(empty);
      setOriginalRows(empty);
    } finally {
      setLoading(false);
    }
  }, [year, monthIndex, store]);

  useEffect(() => {
    load();
  }, [load]);

  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const row of rows) {
      if (planLocked(row)) continue;
      const original = originalRows.find((o) => o.entryDate === row.entryDate);
      if (original && original.plan !== row.plan) count++;
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, originalRows, nowTick]);

  useEffect(() => {
    if (dirtyCount > 0) setJustSaved(false);
  }, [dirtyCount]);

  const total = rows.reduce((acc, r) => acc + (typeof r.plan === "number" ? r.plan : 0), 0);

  function shiftMonth(delta: number) {
    if (dirtyCount > 0 && !window.confirm("У вас есть несохранённые изменения. Перейти и потерять их?")) return;
    const t = year * 12 + monthIndex + delta;
    setYear(Math.floor(t / 12));
    setMonthIndex(((t % 12) + 12) % 12);
  }
  function changeStore(next: string) {
    if (dirtyCount > 0 && !window.confirm("У вас есть несохранённые изменения. Перейти и потерять их?")) return;
    setStore(next);
  }

  function updateCell(index: number, rawValue: string) {
    if (!canEdit || !rows[index] || planLocked(rows[index])) return;
    const text = sanitizeAmountText(rawValue);
    setEditingText(text);
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], plan: parseAmountText(text) };
      return next;
    });
  }

  async function requestUnlock(row: DayRow) {
    if (saving || !row.id) return;
    setError(null);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const uid = userData.user?.id;
      if (!uid) throw new Error("Нет активной сессии.");
      const { error: insertError } = await supabase.from("edit_requests").insert({
        table_name: "sales_plan_entries",
        row_id: row.id,
        entry_date: row.entryDate,
        store,
        context: `Точка «${storeName}», план продаж за ${row.date}.${year}. Заявитель: ${requesterLabel}`,
        requested_by: uid,
      });
      if (insertError) throw insertError;
      setRows((prev) => prev.map((r) => (r.entryDate === row.entryDate ? { ...r, requestPending: true } : r)));
    } catch (e) {
      setError(`Не удалось отправить запрос: ${getErrorMessage(e)}`);
    }
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const failed: string[] = [];
    try {
      for (const row of rows) {
        if (planLocked(row)) continue;
        const original = originalRows.find((o) => o.entryDate === row.entryDate);
        if (!original || original.plan === row.plan) continue;

        const payload: Record<string, unknown> = {
          store,
          entry_date: row.entryDate,
          sales_plan: row.plan === "" ? null : row.plan,
        };
        // Изменённый уже внесённый план снова закрывается: следующая правка —
        // только по новому запросу.
        const planWasChanged = original.planEverEntered && row.plan !== original.plan;
        if (planWasChanged) {
          payload.locked = true;
          payload.unlock_expires_at = null;
        }
        try {
          if (row.id) {
            const { data: updated, error: updateError } = await supabase
              .from("sales_plan_entries")
              .update(payload)
              .eq("id", row.id)
              .select("id");
            if (updateError) throw updateError;
            if (!updated || updated.length === 0) throw new Error("время на изменение истекло — запросите доступ снова");
            if (planWasChanged) {
              const { data: userData } = await supabase.auth.getUser();
              await supabase.from("edit_history").insert({
                table_name: "sales_plan_entries",
                row_id: row.id,
                store,
                summary: `Точка «${storeName}», план продаж за ${row.date}.${year}: ${original.plan === "" ? "—" : original.plan} → ${row.plan === "" ? "—" : row.plan}`,
                changed_by: userData.user?.id ?? null,
                changed_by_name: requesterLabel,
              });
            }
          } else {
            const { error: insertError } = await supabase.from("sales_plan_entries").insert(payload);
            if (insertError) throw insertError;
          }
        } catch (rowError) {
          failed.push(`${row.date}.${year} (${getErrorMessage(rowError)})`);
        }
      }
    } finally {
      await load();
      if (failed.length > 0) {
        setError(`Не удалось сохранить: ${failed.join(", ")}. Остальные даты сохранены — попробуйте ещё раз для этих.`);
      } else {
        setJustSaved(true);
        onSaved?.();
      }
      setSaving(false);
    }
  }

  if (accessibleStores.length === 0) return null;

  return (
    <div className="bg-surface border border-border rounded-card p-5 flex flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-bold">Внесение плана продаж</div>
        <p className="text-[12.5px] text-muted max-w-2xl m-0">
          План вносится отдельно на каждую дату и точку. Внести план на дату можно свободно один раз
          (любая дата, в том числе вперёд); изменить уже внесённый — только по одобренному запросу.
          {!canEdit && " У вас только просмотр — вносить план может сотрудник с доступом «Внесение плана продаж»."}
        </p>
        {error && (
          <div className="flex items-center gap-3 text-sm text-[#A34B36]">
            <span>{error}</span>
            <button type="button" onClick={load} className="font-semibold underline">
              Повторить
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 bg-paper border border-border rounded-card p-1.5">
          <button
            type="button"
            aria-label="Предыдущий месяц"
            onClick={() => shiftMonth(-1)}
            disabled={loading}
            className="w-[30px] h-[30px] rounded-md text-muted disabled:opacity-50"
          >
            ‹
          </button>
          <div className="text-[15px] font-bold min-w-[150px] text-center">
            {MONTH_NAMES[monthIndex]} {year}
          </div>
          <button
            type="button"
            aria-label="Следующий месяц"
            onClick={() => shiftMonth(1)}
            disabled={loading}
            className="w-[30px] h-[30px] rounded-md text-muted disabled:opacity-50"
          >
            ›
          </button>
        </div>
        <select
          value={store}
          onChange={(e) => changeStore(e.target.value)}
          disabled={loading || accessibleStores.length <= 1}
          className="text-[13px] font-semibold bg-paper border border-border rounded-lg px-3 py-2 disabled:opacity-70"
        >
          {accessibleStores.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-[60px_46px_minmax(110px,200px)_1fr] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
        <div>Дата</div>
        <div>День</div>
        <div>План продаж, ₸</div>
        <div className="text-right">Строка</div>
      </div>

      {rows.map((row, i) => {
        const locked = planLocked(row);
        const showCountdown = !locked && row.planEverEntered && row.unlockExpiresAt;
        const cellKey = `plan-${i}`;
        const isEditing = editingField === cellKey;
        return (
          <div
            key={row.entryDate}
            className={`grid grid-cols-[60px_46px_minmax(110px,200px)_1fr] gap-2 items-center py-1 border-b border-borderSoft ${
              row.weekend ? "bg-weekendTint" : ""
            }`}
          >
            <div className="text-[12.5px] text-muted">{row.date}</div>
            <div className="text-[12.5px] text-mutedLight">{row.weekday}</div>
            <input
              type="text"
              inputMode="decimal"
              disabled={!canEdit || locked || loading}
              value={isEditing ? editingText : formatGrouped(row.plan)}
              onFocus={() => {
                setEditingField(cellKey);
                setEditingText(row.plan === "" ? "" : String(row.plan).replace(".", ","));
              }}
              onChange={(e) => updateCell(i, e.target.value)}
              onBlur={() => setEditingField(null)}
              onKeyDown={amountKeyDown(editingText)}
              placeholder="0"
              className="w-full box-border text-right text-[12.5px] rounded-[5px] border border-cellBorder px-1.5 py-1 disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
            />
            <div className="flex flex-col items-end gap-0.5">
              {locked &&
                (row.requestPending ? (
                  <span className="text-[11px] text-mutedLight italic">Ожидает</span>
                ) : (
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => requestUnlock(row)}
                    className="text-[11px] font-semibold text-accent border border-accent rounded-md px-2 py-1 disabled:opacity-50"
                  >
                    Запрос
                  </button>
                ))}
              {showCountdown && (
                <span className="text-[9.5px] text-mutedLight italic">
                  ещё {minutesLeft(row.unlockExpiresAt as string, nowTick)}м
                </span>
              )}
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <div className="text-[13px] text-muted">
          Итого план на месяц:{" "}
          <span className="num text-ink font-bold">
            {total.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₸
          </span>
        </div>
        <button
          type="button"
          disabled={!canEdit || dirtyCount === 0 || saving}
          onClick={handleSave}
          className={`text-[13px] font-bold rounded-lg px-4 py-2.5 transition-colors ${
            dirtyCount > 0 && !saving ? "bg-accent text-paper" : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
          }`}
        >
          {saving ? "Сохраняем…" : justSaved ? "Сохранено" : "Сохранить план"}
        </button>
      </div>
    </div>
  );
}
