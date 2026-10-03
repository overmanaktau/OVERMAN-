"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { getErrorMessage } from "@/lib/errors";

type Employee = { id: string; name: string };

// План продавца на месяц — одно число. Вносится свободно один раз, а изменить
// уже внесённый можно только по одобренному запросу (как план трафика).
type PlanCell = {
  id?: number;
  plan: number | "";
  everEntered: boolean;
  requestPending: boolean;
  unlockExpiresAt: string | null;
};

const EMPTY_CELL: PlanCell = { plan: "", everEntered: false, requestPending: false, unlockExpiresAt: null };

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

// Продавцы берутся из МойСклад по продажам точки за последние дни, и только
// активные (архивные в список не попадают, см. /api/moysklad/employees). Бывшие
// кассиры закрытой кассы Saya Park в список тоже не попадают.
const EMPLOYEE_LOOKBACK_DAYS = 45;
const HIDDEN_EMPLOYEE_NAME = /саяпарк|saya/i;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function monthStart(year: number, monthIndex: number) {
  return `${year}-${pad2(monthIndex + 1)}-01`;
}
function minutesLeft(iso: string, nowMs: number) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / 60000));
}
function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
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
    const allowed = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"];
    if (allowed.includes(e.key)) return;
    if ((e.key === "," || e.key === ".") && !currentText.includes(",")) return;
    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
  };
}

// Внесение плана продаж по продавцам (страница «Продажа»). По умолчанию
// свёрнуто — открывается кнопкой. Внутри: месяц, точка и список активных
// продавцов, у каждого одно поле — план на месяц. План точки и месяца в окне
// «План продаж» — сумма планов продавцов.
export function SalesPlanEntry({ onSaved }: { onSaved?: () => void }) {
  const { isAdmin, permissions, stores, accessibleStoreCodes, fullName, email } = useAuth();
  const canEdit = isAdmin || permissions["sales.plan"].canEdit;
  const requesterLabel = fullName || email || "Пользователь";
  const accessibleStores = stores.filter((s) => accessibleStoreCodes.includes(s.code));

  const [open, setOpen] = useState(false);
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

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [cells, setCells] = useState<Record<string, PlanCell>>({});
  const [originalCells, setOriginalCells] = useState<Record<string, PlanCell>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilterFailed, setActiveFilterFailed] = useState(false);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const cellOf = (employeeId: string): PlanCell => cells[employeeId] ?? EMPTY_CELL;
  function isLocked(cell: PlanCell) {
    if (!cell.everEntered) return false;
    return !cell.unlockExpiresAt || new Date(cell.unlockExpiresAt).getTime() <= nowTick;
  }

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);
    try {
      const month = monthStart(year, monthIndex);
      const lookbackFrom = new Date();
      lookbackFrom.setDate(lookbackFrom.getDate() - EMPLOYEE_LOOKBACK_DAYS);
      const lookbackStr = `${lookbackFrom.getFullYear()}-${pad2(lookbackFrom.getMonth() + 1)}-${pad2(lookbackFrom.getDate())}`;

      const [plansRes, requestsRes, staffRes] = await Promise.all([
        supabase.from("sales_plan_monthly").select("*").eq("store", store).eq("plan_month", month),
        supabase
          .from("edit_requests")
          .select("row_id")
          .eq("table_name", "sales_plan_monthly")
          .eq("status", "pending")
          .eq("store", store)
          .eq("entry_date", month),
        supabase
          .from("moysklad_employee_sales_daily")
          .select("employee_ms_id, employee_name")
          .eq("store", store)
          .gte("sale_date", lookbackStr),
      ]);
      if (plansRes.error) throw plansRes.error;
      if (requestsRes.error) throw requestsRes.error;
      if (staffRes.error) throw staffRes.error;

      // В списке остаются только активные сотрудники МойСклад. Если МойСклад не
      // ответил, показываем всех, но предупреждаем об этом на странице.
      let activeIds: Set<string> | null = null;
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const res = await fetch("/api/moysklad/employees", {
          headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
        });
        if (res.ok) activeIds = new Set(((await res.json()) as { activeIds: string[] }).activeIds);
      } catch {
        // оставляем activeIds = null
      }
      setActiveFilterFailed(activeIds === null);

      const pendingRowIds = new Set((requestsRes.data ?? []).map((r) => r.row_id));
      const byId = new Map<string, Employee>();
      for (const row of (staffRes.data ?? []) as { employee_ms_id: string; employee_name: string }[]) {
        if (HIDDEN_EMPLOYEE_NAME.test(row.employee_name)) continue;
        byId.set(row.employee_ms_id, { id: row.employee_ms_id, name: row.employee_name });
      }
      const next: Record<string, PlanCell> = {};
      for (const p of plansRes.data ?? []) {
        // Кто уже получил план, остаётся в списке, даже если давно не продавал.
        if (!byId.has(p.employee_ms_id)) byId.set(p.employee_ms_id, { id: p.employee_ms_id, name: p.employee_name });
        next[p.employee_ms_id] = {
          id: p.id,
          plan: p.sales_plan ?? "",
          everEntered: p.sales_plan !== null,
          requestPending: pendingRowIds.has(p.id),
          unlockExpiresAt: p.unlock_expires_at ?? null,
        };
      }
      const list = [...byId.values()]
        .filter((e) => !activeIds || activeIds.has(e.id))
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));
      setEmployees(list);
      setCells(next);
      setOriginalCells(next);
    } catch (e) {
      setError(`Не удалось загрузить план: ${getErrorMessage(e)}`);
      setCells({});
      setOriginalCells({});
    } finally {
      setLoading(false);
    }
  }, [year, monthIndex, store]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const dirtyIds = useMemo(() => {
    const ids: string[] = [];
    for (const id of Object.keys(cells)) {
      if (isLocked(cells[id])) continue;
      if ((originalCells[id] ?? EMPTY_CELL).plan !== cells[id].plan) ids.push(id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, originalCells, nowTick]);

  useEffect(() => {
    if (dirtyIds.length > 0) setJustSaved(false);
  }, [dirtyIds.length]);

  const total = employees.reduce((acc, e) => {
    const p = cellOf(e.id).plan;
    return acc + (typeof p === "number" ? p : 0);
  }, 0);

  function confirmLeave() {
    return dirtyIds.length === 0 || window.confirm("У вас есть несохранённые изменения. Перейти и потерять их?");
  }
  function shiftMonth(delta: number) {
    if (!confirmLeave()) return;
    const t = year * 12 + monthIndex + delta;
    setYear(Math.floor(t / 12));
    setMonthIndex(((t % 12) + 12) % 12);
  }
  function changeStore(next: string) {
    if (!confirmLeave()) return;
    setStore(next);
  }

  function updateCell(employeeId: string, rawValue: string) {
    const current = cells[employeeId] ?? EMPTY_CELL;
    if (!canEdit || isLocked(current)) return;
    const text = sanitizeAmountText(rawValue);
    setEditingText(text);
    setCells((prev) => ({ ...prev, [employeeId]: { ...(prev[employeeId] ?? EMPTY_CELL), plan: parseAmountText(text) } }));
  }

  const monthLabel = `${MONTH_NAMES[monthIndex]} ${year}`;

  async function requestUnlock(employee: Employee) {
    const cell = cellOf(employee.id);
    if (saving || !cell.id) return;
    setError(null);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const uid = userData.user?.id;
      if (!uid) throw new Error("Нет активной сессии.");
      const { error: insertError } = await supabase.from("edit_requests").insert({
        table_name: "sales_plan_monthly",
        row_id: cell.id,
        entry_date: monthStart(year, monthIndex),
        store,
        context: `Точка «${storeName}», продавец «${employee.name}», план продаж на ${monthLabel}. Заявитель: ${requesterLabel}`,
        requested_by: uid,
      });
      if (insertError) throw insertError;
      setCells((prev) => ({ ...prev, [employee.id]: { ...cell, requestPending: true } }));
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
      for (const employeeId of dirtyIds) {
        const employee = employees.find((e) => e.id === employeeId);
        if (!employee) continue;
        const cell = cells[employeeId];
        const original = originalCells[employeeId] ?? EMPTY_CELL;

        const payload: Record<string, unknown> = {
          store,
          employee_ms_id: employee.id,
          employee_name: employee.name,
          plan_month: monthStart(year, monthIndex),
          sales_plan: cell.plan === "" ? null : cell.plan,
        };
        // Изменённый уже внесённый план снова закрывается: следующая правка —
        // только по новому запросу.
        const planWasChanged = original.everEntered && cell.plan !== original.plan;
        if (planWasChanged) {
          payload.locked = true;
          payload.unlock_expires_at = null;
        }
        try {
          if (cell.id) {
            const { data: updated, error: updateError } = await supabase
              .from("sales_plan_monthly")
              .update(payload)
              .eq("id", cell.id)
              .select("id");
            if (updateError) throw updateError;
            if (!updated || updated.length === 0) throw new Error("время на изменение истекло — запросите доступ снова");
            if (planWasChanged) {
              const { data: userData } = await supabase.auth.getUser();
              await supabase.from("edit_history").insert({
                table_name: "sales_plan_monthly",
                row_id: cell.id,
                store,
                summary: `Точка «${storeName}», продавец «${employee.name}», план продаж на ${monthLabel}: ${original.plan === "" ? "—" : original.plan} → ${cell.plan === "" ? "—" : cell.plan}`,
                changed_by: userData.user?.id ?? null,
                changed_by_name: requesterLabel,
              });
            }
          } else {
            const { error: insertError } = await supabase.from("sales_plan_monthly").insert(payload);
            if (insertError) throw insertError;
          }
        } catch (rowError) {
          failed.push(`${employee.name} (${getErrorMessage(rowError)})`);
        }
      }
    } finally {
      await load();
      if (failed.length > 0) {
        setError(`Не удалось сохранить: ${failed.join("; ")}. Остальное сохранено — попробуйте ещё раз для этих.`);
      } else {
        setJustSaved(true);
        onSaved?.();
      }
      setSaving(false);
    }
  }

  if (accessibleStores.length === 0) return null;

  return (
    <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <span className="text-[15px] font-bold">Внесение плана продаж по сотрудникам</span>
        <span className="text-[12.5px] font-semibold text-accent border border-accent rounded-md px-3 py-1.5">
          {open ? "Свернуть" : "Открыть"}
        </span>
      </button>

      {open && (
        <>
          <p className="text-[12.5px] text-muted max-w-2xl m-0">
            План вносится каждому продавцу одним числом на весь месяц. План точки и месяца в окне «План продаж» —
            сумма планов продавцов. Внести план на месяц можно свободно один раз, изменить уже внесённый — только
            по одобренному запросу.
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
          {activeFilterFailed && (
            <div className="text-[12.5px] text-[#A34B36]">
              Не удалось получить активных сотрудников из МойСклад — показаны все, кто продавал недавно, в том
              числе возможно уже неактивные.
            </div>
          )}

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
              <div className="text-[15px] font-bold min-w-[150px] text-center">{monthLabel}</div>
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

          {loading && employees.length === 0 ? (
            <div className="text-sm text-muted">Загрузка…</div>
          ) : employees.length === 0 ? (
            <div className="text-sm text-muted">
              Продавцов этой точки пока нет — они появляются в списке после первых продаж в МойСклад.
            </div>
          ) : (
            <div className="flex flex-col max-w-[520px]">
              <div className="grid grid-cols-[1fr_150px_80px] gap-3 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                <div>Продавец</div>
                <div className="text-right">План на месяц, ₸</div>
                <div className="text-right">Строка</div>
              </div>
              {employees.map((e) => {
                const cell = cellOf(e.id);
                const locked = isLocked(cell);
                const isEditing = editingId === e.id;
                const showCountdown = !locked && cell.everEntered && cell.unlockExpiresAt;
                return (
                  <div
                    key={e.id}
                    className="grid grid-cols-[1fr_150px_80px] gap-3 items-center py-1.5 border-b border-borderSoft"
                  >
                    <div className="text-[13px] font-semibold truncate">{e.name}</div>
                    <input
                      type="text"
                      inputMode="decimal"
                      disabled={!canEdit || locked || loading}
                      value={isEditing ? editingText : formatGrouped(cell.plan)}
                      onFocus={() => {
                        setEditingId(e.id);
                        setEditingText(cell.plan === "" ? "" : String(cell.plan).replace(".", ","));
                      }}
                      onChange={(ev) => updateCell(e.id, ev.target.value)}
                      onBlur={() => setEditingId(null)}
                      onKeyDown={amountKeyDown(editingText)}
                      placeholder="0"
                      className="w-full box-border text-right text-[12.5px] rounded-[5px] border border-cellBorder px-1.5 py-1 disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                    />
                    <div className="flex flex-col items-end gap-0.5">
                      {locked &&
                        (cell.requestPending ? (
                          <span className="text-[11px] text-mutedLight italic">Ожидает</span>
                        ) : (
                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => requestUnlock(e)}
                            className="text-[11px] font-semibold text-accent border border-accent rounded-md px-2 py-1 disabled:opacity-50"
                          >
                            Запрос
                          </button>
                        ))}
                      {showCountdown && (
                        <span className="text-[9.5px] text-mutedLight italic">
                          ещё {minutesLeft(cell.unlockExpiresAt as string, nowTick)}м
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="grid grid-cols-[1fr_150px_80px] gap-3 items-center pt-2.5 text-[13px] font-bold">
                <div>Итого, {storeName}</div>
                <div className="num text-right">{money(total)}</div>
                <div />
              </div>
            </div>
          )}

          {employees.length > 0 && (
            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={!canEdit || dirtyIds.length === 0 || saving}
                onClick={handleSave}
                className={`text-[13px] font-bold rounded-lg px-4 py-2.5 transition-colors ${
                  dirtyIds.length > 0 && !saving ? "bg-accent text-paper" : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
                }`}
              >
                {saving ? "Сохраняем…" : justSaved ? "Сохранено" : "Сохранить план"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
