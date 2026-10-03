"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { getErrorMessage } from "@/lib/errors";

type Employee = { id: string; name: string };

// Одна ячейка плана: сотрудник + дата. План вносится свободно один раз, а
// изменить уже внесённый можно только по одобренному запросу (как план трафика).
type Cell = {
  id?: number;
  plan: number | "";
  everEntered: boolean;
  requestPending: boolean;
  unlockExpiresAt: string | null;
};

const EMPTY_CELL: Cell = { plan: "", everEntered: false, requestPending: false, unlockExpiresAt: null };

const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

// Сотрудники берутся из МойСклад по продажам точки за последние дни. Бывшие
// кассиры закрытой кассы Saya Park в список не попадают (если у них нет плана).
const EMPLOYEE_LOOKBACK_DAYS = 45;
const HIDDEN_EMPLOYEE_NAME = /саяпарк|saya/i;

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
    const allowed = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (allowed.includes(e.key)) return;
    if ((e.key === "," || e.key === ".") && !currentText.includes(",")) return;
    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
  };
}

// Внесение плана продаж по сотрудникам (страница «Продажа»). По умолчанию
// свёрнуто — открывается кнопкой. Внутри: месяц, точка, имена сотрудников; по
// нажатию на имя — календарь месяца с планом этого сотрудника на каждую дату.
// План точки и месяца в окне «План продаж» — сумма планов сотрудников.
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
  const [selectedEmployee, setSelectedEmployee] = useState<string>("");
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [originalCells, setOriginalCells] = useState<Record<string, Cell>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const keyOf = (employeeId: string, date: string) => `${employeeId}|${date}`;
  const cellOf = (employeeId: string, date: string): Cell => cells[keyOf(employeeId, date)] ?? EMPTY_CELL;

  function isLocked(cell: Cell) {
    if (!cell.everEntered) return false;
    return !cell.unlockExpiresAt || new Date(cell.unlockExpiresAt).getTime() <= nowTick;
  }

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);
    try {
      const firstStr = ymd(year, monthIndex, 1);
      const lastStr = ymd(year, monthIndex, daysInMonth(year, monthIndex));
      const lookbackFrom = new Date();
      lookbackFrom.setDate(lookbackFrom.getDate() - EMPLOYEE_LOOKBACK_DAYS);
      const lookbackStr = ymd(lookbackFrom.getFullYear(), lookbackFrom.getMonth(), lookbackFrom.getDate());

      const [entriesRes, requestsRes, staffRes] = await Promise.all([
        supabase.from("sales_plan_entries").select("*").eq("store", store).gte("entry_date", firstStr).lte("entry_date", lastStr),
        supabase
          .from("edit_requests")
          .select("row_id")
          .eq("table_name", "sales_plan_entries")
          .eq("status", "pending")
          .eq("store", store)
          .gte("entry_date", firstStr)
          .lte("entry_date", lastStr),
        supabase
          .from("moysklad_employee_sales_daily")
          .select("employee_ms_id, employee_name")
          .eq("store", store)
          .gte("sale_date", lookbackStr),
      ]);
      if (entriesRes.error) throw entriesRes.error;
      if (requestsRes.error) throw requestsRes.error;
      if (staffRes.error) throw staffRes.error;

      const pendingRowIds = new Set((requestsRes.data ?? []).map((r) => r.row_id));
      const next: Record<string, Cell> = {};
      const byId = new Map<string, Employee>();
      for (const row of (staffRes.data ?? []) as { employee_ms_id: string; employee_name: string }[]) {
        if (HIDDEN_EMPLOYEE_NAME.test(row.employee_name)) continue;
        byId.set(row.employee_ms_id, { id: row.employee_ms_id, name: row.employee_name });
      }
      for (const e of entriesRes.data ?? []) {
        // Кто уже получил план, остаётся в списке, даже если давно не продавал.
        if (!byId.has(e.employee_ms_id)) byId.set(e.employee_ms_id, { id: e.employee_ms_id, name: e.employee_name });
        next[keyOf(e.employee_ms_id, e.entry_date)] = {
          id: e.id,
          plan: e.sales_plan ?? "",
          everEntered: e.sales_plan !== null,
          requestPending: pendingRowIds.has(e.id),
          unlockExpiresAt: e.unlock_expires_at ?? null,
        };
      }
      const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
      setEmployees(list);
      setSelectedEmployee((prev) => (prev && list.some((x) => x.id === prev) ? prev : list[0]?.id ?? ""));
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

  const dirtyKeys = useMemo(() => {
    const keys: string[] = [];
    for (const key of Object.keys(cells)) {
      if (isLocked(cells[key])) continue;
      if ((originalCells[key] ?? EMPTY_CELL).plan !== cells[key].plan) keys.push(key);
    }
    return keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, originalCells, nowTick]);

  useEffect(() => {
    if (dirtyKeys.length > 0) setJustSaved(false);
  }, [dirtyKeys.length]);

  const monthTotal = Object.values(cells).reduce((acc, c) => acc + (typeof c.plan === "number" ? c.plan : 0), 0);
  const employeeTotal = (employeeId: string) =>
    Object.entries(cells).reduce(
      (acc, [key, c]) => (key.startsWith(`${employeeId}|`) && typeof c.plan === "number" ? acc + c.plan : acc),
      0
    );

  function confirmLeave() {
    return dirtyKeys.length === 0 || window.confirm("У вас есть несохранённые изменения. Перейти и потерять их?");
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

  function updateCell(employeeId: string, date: string, rawValue: string) {
    const key = keyOf(employeeId, date);
    const current = cells[key] ?? EMPTY_CELL;
    if (!canEdit || isLocked(current)) return;
    const text = sanitizeAmountText(rawValue);
    setEditingText(text);
    setCells((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_CELL), plan: parseAmountText(text) } }));
  }

  async function requestUnlock(employee: Employee, date: string) {
    const cell = cellOf(employee.id, date);
    if (saving || !cell.id) return;
    setError(null);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const uid = userData.user?.id;
      if (!uid) throw new Error("Нет активной сессии.");
      const [y, m, d] = date.split("-");
      const { error: insertError } = await supabase.from("edit_requests").insert({
        table_name: "sales_plan_entries",
        row_id: cell.id,
        entry_date: date,
        store,
        context: `Точка «${storeName}», сотрудник «${employee.name}», план продаж за ${d}.${m}.${y}. Заявитель: ${requesterLabel}`,
        requested_by: uid,
      });
      if (insertError) throw insertError;
      setCells((prev) => ({ ...prev, [keyOf(employee.id, date)]: { ...cell, requestPending: true } }));
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
      for (const key of dirtyKeys) {
        const [employeeId, date] = key.split("|");
        const employee = employees.find((e) => e.id === employeeId);
        if (!employee) continue;
        const cell = cells[key];
        const original = originalCells[key] ?? EMPTY_CELL;
        const [y, m, d] = date.split("-");
        const label = `${employee.name}, ${d}.${m}.${y}`;

        const payload: Record<string, unknown> = {
          store,
          employee_ms_id: employee.id,
          employee_name: employee.name,
          entry_date: date,
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
              .from("sales_plan_entries")
              .update(payload)
              .eq("id", cell.id)
              .select("id");
            if (updateError) throw updateError;
            if (!updated || updated.length === 0) throw new Error("время на изменение истекло — запросите доступ снова");
            if (planWasChanged) {
              const { data: userData } = await supabase.auth.getUser();
              await supabase.from("edit_history").insert({
                table_name: "sales_plan_entries",
                row_id: cell.id,
                store,
                summary: `Точка «${storeName}», сотрудник «${employee.name}», план продаж за ${d}.${m}.${y}: ${original.plan === "" ? "—" : original.plan} → ${cell.plan === "" ? "—" : cell.plan}`,
                changed_by: userData.user?.id ?? null,
                changed_by_name: requesterLabel,
              });
            }
          } else {
            const { error: insertError } = await supabase.from("sales_plan_entries").insert(payload);
            if (insertError) throw insertError;
          }
        } catch (rowError) {
          failed.push(`${label} (${getErrorMessage(rowError)})`);
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

  const employee = employees.find((e) => e.id === selectedEmployee) ?? null;
  const firstWeekdayOffset = (new Date(year, monthIndex, 1).getDay() + 6) % 7; // неделя с понедельника
  const dayCount = daysInMonth(year, monthIndex);

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
            План вносится на каждую дату отдельно для каждого сотрудника. План точки и месяца в окне «План продаж» —
            сумма планов сотрудников. Внести план на дату можно свободно один раз (любая дата, в том числе вперёд),
            изменить уже внесённый — только по одобренному запросу.
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

          {loading && employees.length === 0 ? (
            <div className="text-sm text-muted">Загрузка…</div>
          ) : employees.length === 0 ? (
            <div className="text-sm text-muted">
              Сотрудников этой точки пока нет — они появляются в списке после первых продаж в МойСклад.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {employees.map((e) => {
                  const active = e.id === selectedEmployee;
                  const total = employeeTotal(e.id);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setSelectedEmployee(e.id)}
                      className={`flex flex-col items-start rounded-lg border px-3 py-1.5 text-left transition-colors ${
                        active ? "border-accent bg-accent text-paper" : "border-border bg-paper text-ink"
                      }`}
                    >
                      <span className="text-[13px] font-semibold leading-tight">{e.name}</span>
                      <span className={`text-[11px] num ${active ? "text-paper/80" : "text-mutedLight"}`}>
                        {total > 0 ? money(total) : "план не внесён"}
                      </span>
                    </button>
                  );
                })}
              </div>

              {employee && (
                <div className="flex flex-col gap-2 max-w-[760px]">
                  <div className="hidden sm:grid grid-cols-7 gap-1.5 text-[10.5px] uppercase tracking-wide text-mutedLight text-center">
                    {WEEKDAYS_SHORT.map((w) => (
                      <div key={w}>{w}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-7 gap-1.5">
                    {Array.from({ length: firstWeekdayOffset }).map((_, i) => (
                      <div key={`blank-${i}`} className="hidden sm:block" />
                    ))}
                    {Array.from({ length: dayCount }).map((_, i) => {
                      const day = i + 1;
                      const date = ymd(year, monthIndex, day);
                      const weekdayIdx = (firstWeekdayOffset + i) % 7;
                      const weekend = weekdayIdx >= 5;
                      const cell = cellOf(employee.id, date);
                      const locked = isLocked(cell);
                      const key = keyOf(employee.id, date);
                      const isEditing = editingKey === key;
                      const showCountdown = !locked && cell.everEntered && cell.unlockExpiresAt;
                      return (
                        <div
                          key={date}
                          className={`rounded-lg border border-borderSoft p-1.5 flex flex-col gap-1 min-w-0 ${
                            weekend ? "bg-weekendTint" : ""
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-1">
                            <span className="text-[12px] font-semibold">{day}</span>
                            <span className="text-[10px] text-mutedLight sm:hidden">{WEEKDAYS_SHORT[weekdayIdx]}</span>
                          </div>
                          <input
                            type="text"
                            inputMode="decimal"
                            disabled={!canEdit || locked || loading}
                            value={isEditing ? editingText : formatGrouped(cell.plan)}
                            onFocus={() => {
                              setEditingKey(key);
                              setEditingText(cell.plan === "" ? "" : String(cell.plan).replace(".", ","));
                            }}
                            onChange={(e) => updateCell(employee.id, date, e.target.value)}
                            onBlur={() => setEditingKey(null)}
                            onKeyDown={amountKeyDown(editingText)}
                            placeholder="0"
                            className="w-full box-border text-right text-[12px] rounded-[5px] border border-cellBorder px-1.5 py-1 disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                          />
                          {(locked || showCountdown) && (
                            <div className="flex items-center justify-end min-h-[18px]">
                              {locked &&
                                (cell.requestPending ? (
                                  <span className="text-[10px] text-mutedLight italic">ожидает</span>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={!canEdit}
                                    onClick={() => requestUnlock(employee, date)}
                                    className="text-[10px] font-semibold text-accent underline disabled:opacity-50"
                                  >
                                    запрос
                                  </button>
                                ))}
                              {showCountdown && (
                                <span className="text-[10px] text-mutedLight italic">
                                  ещё {minutesLeft(cell.unlockExpiresAt as string, nowTick)}м
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-borderSoft">
                <div className="text-[13px] text-muted flex flex-col gap-0.5">
                  {employee && (
                    <span>
                      {employee.name}, план на месяц: <span className="num text-ink font-bold">{money(employeeTotal(employee.id))}</span>
                    </span>
                  )}
                  <span>
                    Все сотрудники, {storeName}: <span className="num text-ink font-bold">{money(monthTotal)}</span>
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!canEdit || dirtyKeys.length === 0 || saving}
                  onClick={handleSave}
                  className={`text-[13px] font-bold rounded-lg px-4 py-2.5 transition-colors ${
                    dirtyKeys.length > 0 && !saving ? "bg-accent text-paper" : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
                  }`}
                >
                  {saving ? "Сохраняем…" : justSaved ? "Сохранено" : "Сохранить план"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
