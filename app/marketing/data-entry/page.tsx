"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { getErrorMessage } from "@/lib/errors";
import { DataTableCard } from "@/components/DataTableCard";

type DayRow = {
  id?: number;
  entryDate: string; // "YYYY-MM-DD", used as the DB key
  date: string; // "DD.MM", display only
  weekday: string;
  weekend: boolean;
  trafficPlan: number | "";
  trafficFact: number | "";
  instagram: number | "";
  tiktok: number | "";
  instagramPublic: number | "";
  flyer: number | "";
  twoGis: number | "";
};

type ExpenseRow = {
  id?: number;
  date: string; // "YYYY-MM-DD"
  category: string;
  amount: number | "";
  comment: string;
  locked: boolean;
  requestPending: boolean;
  unlockExpiresAt: string | null;
};

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]; // matches Date#getDay()
const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const NUMERIC_FIELDS: (keyof Pick<
  DayRow,
  "trafficPlan" | "trafficFact" | "instagram" | "tiktok" | "instagramPublic" | "flyer" | "twoGis"
>)[] = ["trafficPlan", "trafficFact", "instagram", "tiktok", "instagramPublic", "flyer", "twoGis"];

// trafficPlan/trafficFact are visitor counts — always whole numbers. The 5
// channel fields are marketing spend (money) — same kopeck/decimal support
// as expense amounts.
const DECIMAL_FIELDS = new Set<(typeof NUMERIC_FIELDS)[number]>([
  "instagram",
  "tiktok",
  "instagramPublic",
  "flyer",
  "twoGis",
]);

const DB_FIELD = {
  trafficPlan: "traffic_plan",
  trafficFact: "traffic_fact",
  instagram: "instagram",
  tiktok: "tiktok",
  instagramPublic: "instagram_public",
  flyer: "flyer",
  twoGis: "two_gis",
} as const;

const FIELD_LABEL: Record<(typeof NUMERIC_FIELDS)[number], string> = {
  trafficPlan: "Трафик план",
  trafficFact: "Трафик факт",
  instagram: "Instagram",
  tiktok: "TikTok",
  instagramPublic: "Insta паблик",
  flyer: "Флаер",
  twoGis: "2ГИС",
};

function diffDayRow(original: DayRow, updated: DayRow): string {
  const changes: string[] = [];
  for (const f of NUMERIC_FIELDS) {
    if (original[f] !== updated[f]) {
      changes.push(`${FIELD_LABEL[f]}: ${original[f] === "" ? "—" : original[f]} → ${updated[f] === "" ? "—" : updated[f]}`);
    }
  }
  return changes.join("; ");
}

function diffExpense(original: ExpenseRow, updated: ExpenseRow): string {
  const changes: string[] = [];
  if (original.date !== updated.date) changes.push(`Дата: ${original.date || "—"} → ${updated.date || "—"}`);
  if (original.category !== updated.category) changes.push(`Статья: «${original.category || "—"}» → «${updated.category || "—"}»`);
  if (original.amount !== updated.amount) changes.push(`Сумма: ${original.amount === "" ? "—" : original.amount} → ${updated.amount === "" ? "—" : updated.amount}`);
  if (original.comment !== updated.comment) changes.push(`Комментарий: «${original.comment || "—"}» → «${updated.comment || "—"}»`);
  return changes.join("; ");
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function ymd(year: number, monthIndex: number, day: number) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// Keyboard-only, digits-only: no arrow-key increment/decrement, no "e"/"+"/"-"/".",
// no mouse-wheel scrubbing — just typing numbers, backspace, and basic navigation.
function digitsOnlyKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.ctrlKey || e.metaKey) return; // allow copy/paste/select-all
  const allowed = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"];
  if (allowed.includes(e.key)) return;
  if (!/^[0-9]$/.test(e.key)) e.preventDefault();
}

// Same as digitsOnlyKeyDown, but also allows one decimal marker (comma or
// period, either types "," — matches ru-RU convention) — for expenses with
// kopecks, e.g. "10 000,25". A second decimal marker is blocked.
function amountKeyDown(currentText: string) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey) return;
    const allowed = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (allowed.includes(e.key)) return;
    if ((e.key === "," || e.key === ".") && !currentText.includes(",")) return;
    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
  };
}

// Strips everything except digits and a single "," decimal marker (typed as
// either "," or "."), and caps it to 2 decimal digits — applied on change so
// paste/autofill can't sneak in anything else.
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

// "0 000" grouping (ru-RU thousands separator) for display when a cell isn't
// being actively typed into — up to 2 decimals for money, none for counts.
function formatGrouped(n: number | "", maximumFractionDigits = 0): string {
  if (n === "") return "";
  return n.toLocaleString("ru-RU", { maximumFractionDigits });
}

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером базы данных. Проверьте интернет-соединение и попробуйте снова.";
  }
  if (/JWT|session|401|403/i.test(message)) {
    return "Сессия истекла или нет доступа. Попробуйте выйти и войти снова.";
  }
  if (/запросите доступ снова|требует одобренного запроса/i.test(message)) {
    return message;
  }
  return `Не удалось выполнить операцию: ${message}`;
}

function numericSnapshot(row: DayRow) {
  return NUMERIC_FIELDS.map((f) => row[f]).join("|");
}

function expenseSnapshot(e: ExpenseRow) {
  return [e.date, e.category, e.amount, e.comment].join("|");
}

function buildMonthRows(year: number, monthIndex: number): DayRow[] {
  const total = daysInMonth(year, monthIndex);
  const rows: DayRow[] = [];
  for (let d = 1; d <= total; d++) {
    const weekday = WEEKDAYS[new Date(year, monthIndex, d).getDay()];
    rows.push({
      entryDate: ymd(year, monthIndex, d),
      date: `${pad2(d)}.${pad2(monthIndex + 1)}`,
      weekday,
      weekend: weekday === "Сб" || weekday === "Вс",
      trafficPlan: "",
      trafficFact: "",
      instagram: "",
      tiktok: "",
      instagramPublic: "",
      flyer: "",
      twoGis: "",
    });
  }
  return rows;
}

function minutesLeft(iso: string, nowMs: number) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / 60000));
}

export default function DataEntryPage() {
  const { isAdmin, permissions, stores, accessibleStoreCodes, fullName, email } = useAuth();
  const canView = isAdmin || permissions["marketing.data_entry"].canView;
  const canEditSection = isAdmin || permissions["marketing.data_entry"].canEdit;
  const requesterLabel = fullName || email || "Пользователь";

  const accessibleStores = stores.filter((s) => accessibleStoreCodes.includes(s.code));

  const [store, setStore] = useState<string>("");

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

  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [originalExpenses, setOriginalExpenses] = useState<ExpenseRow[]>([]);

  // While a numeric cell is focused, it shows exactly what's being typed
  // (raw digits, or digits+comma for amounts) instead of the "0 000"
  // grouped display — reformatting mid-edit would jump the cursor around.
  // It snaps to the grouped format again on blur.
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const [loading, setLoading] = useState(true);
  const [savingDays, setSavingDays] = useState(false);
  const [savingExpenses, setSavingExpenses] = useState(false);
  const [justSavedDays, setJustSavedDays] = useState(false);
  const [justSavedExpenses, setJustSavedExpenses] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  function rowIsExpired(unlockExpiresAt: string | null) {
    return !!unlockExpiresAt && new Date(unlockExpiresAt).getTime() <= nowTick;
  }

  function expenseEffectivelyLocked(exp: ExpenseRow) {
    return exp.locked || rowIsExpired(exp.unlockExpiresAt);
  }

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);

    try {
      const firstStr = ymd(year, monthIndex, 1);
      const lastStr = ymd(year, monthIndex, daysInMonth(year, monthIndex));

      const [entriesRes, expensesRes] = await Promise.all([
        supabase
          .from("traffic_entries")
          .select("*")
          .eq("store", store)
          .gte("entry_date", firstStr)
          .lte("entry_date", lastStr),
        supabase
          .from("extra_expenses")
          .select("*")
          .gte("expense_date", firstStr)
          .lte("expense_date", lastStr)
          .order("expense_date"),
      ]);

      if (entriesRes.error) throw entriesRes.error;
      if (expensesRes.error) throw expensesRes.error;

      const expenseIds = (expensesRes.data ?? []).map((e) => e.id);

      const expReqRes = expenseIds.length
        ? await supabase
            .from("edit_requests")
            .select("row_id")
            .eq("table_name", "extra_expenses")
            .eq("status", "pending")
            .in("row_id", expenseIds)
        : { data: [] as { row_id: number }[], error: null };
      if (expReqRes.error) throw expReqRes.error;

      const pendingExpenseIds = new Set((expReqRes.data ?? []).map((r) => r.row_id));

      const byDate = new Map((entriesRes.data ?? []).map((e) => [e.entry_date, e]));
      const merged = buildMonthRows(year, monthIndex).map((row) => {
        const db = byDate.get(row.entryDate);
        if (!db) return row;
        return {
          ...row,
          id: db.id,
          trafficPlan: db.traffic_plan ?? "",
          trafficFact: db.traffic_fact ?? "",
          instagram: db.instagram ?? "",
          tiktok: db.tiktok ?? "",
          instagramPublic: db.instagram_public ?? "",
          flyer: db.flyer ?? "",
          twoGis: db.two_gis ?? "",
        };
      });

      const mergedExpenses = (expensesRes.data ?? []).map((e) => ({
        id: e.id,
        date: e.expense_date,
        category: e.category ?? "",
        amount: e.amount ?? "",
        comment: e.comment ?? "",
        locked: e.locked ?? false,
        requestPending: pendingExpenseIds.has(e.id),
        unlockExpiresAt: e.unlock_expires_at ?? null,
      }));

      setRows(merged);
      setOriginalRows(merged);
      setExpenses(mergedExpenses);
      setOriginalExpenses(mergedExpenses);
    } catch (e) {
      setError(friendlyError(e));
      const empty = buildMonthRows(year, monthIndex);
      setRows(empty);
      setOriginalRows(empty);
      setExpenses([]);
      setOriginalExpenses([]);
    } finally {
      setLoading(false);
    }
  }, [year, monthIndex, store]);

  useEffect(() => {
    load();
  }, [load]);

  const dirtyDayCount = useMemo(() => {
    // "план" can always change, so no row is ever fully excluded here — the
    // disabled inputs already stop illegal edits to the other six fields,
    // and the DB enforces it too, so a plain diff check is enough.
    let count = 0;
    for (const row of rows) {
      const original = originalRows.find((o) => o.entryDate === row.entryDate);
      if (original && numericSnapshot(row) !== numericSnapshot(original)) count++;
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, originalRows]);

  const dirtyExpenseCount = useMemo(() => {
    let count = 0;
    expenses.forEach((exp, i) => {
      if (expenseEffectivelyLocked(exp)) return;
      const original = originalExpenses[i];
      if (original && expenseSnapshot(exp) !== expenseSnapshot(original)) count++;
    });
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses, originalExpenses, nowTick]);

  const dirty = dirtyDayCount > 0 || dirtyExpenseCount > 0;

  // "Сохранено" is a transient confirmation — clear it as soon as the user
  // touches something again, so it can't linger and look like a stale claim.
  useEffect(() => {
    if (dirtyDayCount > 0) setJustSavedDays(false);
  }, [dirtyDayCount]);
  useEffect(() => {
    if (dirtyExpenseCount > 0) setJustSavedExpenses(false);
  }, [dirtyExpenseCount]);

  function shiftMonth(delta: number) {
    const doShift = () => {
      const total = year * 12 + monthIndex + delta;
      setYear(Math.floor(total / 12));
      setMonthIndex(((total % 12) + 12) % 12);
    };
    if (dirty && !window.confirm("У вас есть несохранённые изменения. Перейти и потерять их?")) return;
    doShift();
  }

  function changeStore(nextStore: string) {
    if (dirty && !window.confirm("У вас есть несохранённые изменения. Перейти и потерять их?")) return;
    setStore(nextStore);
  }

  function updateCell(index: number, field: (typeof NUMERIC_FIELDS)[number], rawValue: string) {
    if (!canEditSection || !rows[index]) return;
    if (DECIMAL_FIELDS.has(field)) {
      const text = sanitizeAmountText(rawValue); // digits + one "," decimal marker, even from paste
      setEditingText(text);
      setRows((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], [field]: parseAmountText(text) };
        return next;
      });
      return;
    }
    const value = rawValue.replace(/\D/g, ""); // digits only, even from paste/autofill
    setEditingText(value);
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value === "" ? "" : Number(value) };
      return next;
    });
  }

  function updateExpense(index: number, field: keyof Pick<ExpenseRow, "date" | "category" | "amount" | "comment">, rawValue: string) {
    if (!canEditSection || !expenses[index] || expenseEffectivelyLocked(expenses[index])) return;
    if (field === "amount") {
      const text = sanitizeAmountText(rawValue); // digits + one "," decimal marker, even from paste
      setEditingText(text);
      setExpenses((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], amount: parseAmountText(text) };
        return next;
      });
      return;
    }
    setExpenses((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: rawValue };
      return next;
    });
  }

  async function requestExpenseUnlock(exp: ExpenseRow) {
    if (!exp.id || savingExpenses) return;
    setError(null);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const uid = userData.user?.id;
      if (!uid) throw new Error("Нет активной сессии.");

      const context = `Доп. расход «${exp.category || "без статьи"}» от ${exp.date || "—"}. Заявитель: ${requesterLabel}`;
      const { error } = await supabase.from("edit_requests").insert({
        table_name: "extra_expenses",
        row_id: exp.id,
        store: null,
        context,
        requested_by: uid,
      });
      if (error) throw error;

      setExpenses((prev) => prev.map((e) => (e.id === exp.id ? { ...e, requestPending: true } : e)));
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  const totals = useMemo(() => {
    const sum = (field: (typeof NUMERIC_FIELDS)[number]) =>
      rows.reduce((acc, r) => acc + (typeof r[field] === "number" ? (r[field] as number) : 0), 0);
    return {
      trafficPlan: sum("trafficPlan"),
      trafficFact: sum("trafficFact"),
      instagram: sum("instagram"),
      tiktok: sum("tiktok"),
      instagramPublic: sum("instagramPublic"),
      flyer: sum("flyer"),
      twoGis: sum("twoGis"),
    };
  }, [rows]);

  const channelTotal =
    totals.instagram + totals.tiktok + totals.instagramPublic + totals.flyer + totals.twoGis;
  const expensesTotal = expenses.reduce((acc, e) => acc + (typeof e.amount === "number" ? e.amount : 0), 0);

  async function handleSaveDayRows() {
    if (savingDays) return; // guards against a second click landing before the button disables
    setSavingDays(true);
    setError(null);
    const failed: string[] = [];
    try {
      for (const row of rows) {
        const original = originalRows.find((o) => o.entryDate === row.entryDate);
        if (!original || numericSnapshot(row) === numericSnapshot(original)) continue;

        const payload: Record<string, unknown> = { store, entry_date: row.entryDate };
        for (const f of NUMERIC_FIELDS) payload[DB_FIELD[f]] = row[f] === "" ? null : row[f];

        try {
          if (row.id) {
            const { error } = await supabase.from("traffic_entries").update(payload).eq("id", row.id);
            if (error) throw error;

            const changeDescription = diffDayRow(original, row);
            if (changeDescription) {
              const { data: userData } = await supabase.auth.getUser();
              await supabase.from("edit_history").insert({
                table_name: "traffic_entries",
                row_id: row.id,
                store,
                summary: `Точка «${storeName}», трафик и каналы за ${row.date}.${year}: ${changeDescription}`,
                changed_by: userData.user?.id ?? null,
                changed_by_name: requesterLabel,
              });
            }
          } else {
            const { error } = await supabase.from("traffic_entries").insert(payload);
            if (error) throw error;
          }
        } catch (rowError) {
          // One row failing (a network blip, a momentary conflict) must not
          // abort the rest — every other dirty row still gets its own
          // attempt, and we always reload afterwards so the page never
          // shows local state that's out of sync with what's really saved.
          failed.push(`${row.date}.${year} (${getErrorMessage(rowError)})`);
        }
      }

    } finally {
      // load() clears the error banner itself, so setting ours before
      // calling it would just get wiped — set it only after load() settles.
      await load();
      if (failed.length > 0) {
        setError(`Не удалось сохранить: ${failed.join(", ")}. Остальные строки сохранены — попробуйте ещё раз для этих дат.`);
      } else {
        setJustSavedDays(true);
      }
      setSavingDays(false);
    }
  }

  async function handleSaveExpenses() {
    if (savingExpenses) return;
    setSavingExpenses(true);
    setError(null);
    const failed: string[] = [];
    try {
      for (let i = 0; i < expenses.length; i++) {
        const exp = expenses[i];
        if (expenseEffectivelyLocked(exp)) continue;
        const original = originalExpenses[i];
        if (!original || expenseSnapshot(exp) === expenseSnapshot(original)) continue;

        const payload = {
          expense_date: exp.date || null,
          category: exp.category,
          amount: exp.amount === "" ? 0 : exp.amount,
          comment: exp.comment,
          locked: true,
          unlock_expires_at: null,
        };

        try {
          if (exp.id) {
            const { data: updated, error } = await supabase.from("extra_expenses").update(payload).eq("id", exp.id).select("id");
            if (error) throw error;
            if (!updated || updated.length === 0) {
              throw new Error("время на изменение истекло — запросите доступ снова");
            }

            const changeDescription = diffExpense(original, exp);
            if (changeDescription) {
              const { data: userData } = await supabase.auth.getUser();
              await supabase.from("edit_history").insert({
                table_name: "extra_expenses",
                row_id: exp.id,
                store: null,
                summary: `Доп. расход «${exp.category || "без статьи"}» от ${exp.date || "—"}: ${changeDescription}`,
                changed_by: userData.user?.id ?? null,
                changed_by_name: requesterLabel,
              });
            }
          } else {
            const { error } = await supabase.from("extra_expenses").insert(payload);
            if (error) throw error;
          }
        } catch (rowError) {
          // Same reasoning as handleSaveDayRows: one row's failure must not
          // abort the rest, and we always reload so the page reflects what's
          // really in the database.
          failed.push(`«${exp.category || "без статьи"}» (${getErrorMessage(rowError)})`);
        }
      }

    } finally {
      await load();
      if (failed.length > 0) {
        setError(`Не удалось сохранить: ${failed.join(", ")}. Остальные расходы сохранены — попробуйте ещё раз для этих строк.`);
      } else {
        setJustSavedExpenses(true);
      }
      setSavingExpenses(false);
    }
  }

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Внесение данных».</p>
      </div>
    );
  }

  if (accessibleStores.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа ни к одной точке продаж.</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Маркетинг</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Внесение данных</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Трафик и каналы можно свободно вносить и менять — любая дата, без запроса. Таблица
          трафика и дополнительные расходы сохраняются отдельно — своей кнопкой «Сохранить» под
          каждой таблицей.
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

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 bg-surface border border-border rounded-card p-1.5">
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
        <div className="flex items-center gap-2">
          <select
            value={store}
            onChange={(e) => changeStore(e.target.value)}
            disabled={loading || accessibleStores.length <= 1}
            className="text-[13px] font-semibold bg-surface border border-border rounded-lg px-3 py-2 disabled:opacity-70"
          >
            {accessibleStores.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <DataTableCard
        title={`Трафик и расходы по каналам — ${MONTH_NAMES[monthIndex].toLowerCase()} ${year}`}
        rows={rows}
        getSearchText={(row) => `${row.date} ${row.weekday}`}
        csvHeaders={["Дата", "День", "Трафик план", "Трафик факт", "Instagram", "TikTok", "Insta паблик", "Флаер", "2ГИС"]}
        toCsvRow={(row) => [
          row.date,
          row.weekday,
          row.trafficPlan === "" ? 0 : row.trafficPlan,
          row.trafficFact === "" ? 0 : row.trafficFact,
          row.instagram === "" ? 0 : row.instagram,
          row.tiktok === "" ? 0 : row.tiktok,
          row.instagramPublic === "" ? 0 : row.instagramPublic,
          row.flyer === "" ? 0 : row.flyer,
          row.twoGis === "" ? 0 : row.twoGis,
        ]}
        csvFilename={`traffic-${year}-${pad2(monthIndex + 1)}.csv`}
      >
        {(visibleRows) => (
          <>
            <div className="grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Дата</div>
              <div>День</div>
              <div>Трафик план</div>
              <div>Трафик факт</div>
              <div>Instagram</div>
              <div>TikTok</div>
              <div>Insta паблик</div>
              <div>Флаер</div>
              <div>2ГИС</div>
            </div>

            {visibleRows.map((row) => {
              const i = rows.indexOf(row);
              return (
                <div
                  key={row.entryDate}
                  className={`grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 items-center py-1 border-b border-borderSoft ${
                    row.weekend ? "bg-weekendTint" : ""
                  }`}
                >
                  <div className="text-[12.5px] text-muted">{row.date}</div>
                  <div className="text-[12.5px] text-mutedLight">{row.weekday}</div>
                  {NUMERIC_FIELDS.map((field) => {
                    const cellKey = `day-${i}-${field}`;
                    const isEditing = editingField === cellKey;
                    const isDecimal = DECIMAL_FIELDS.has(field);
                    return (
                      <input
                        key={field}
                        type="text"
                        inputMode={isDecimal ? "decimal" : "numeric"}
                        disabled={!canEditSection}
                        value={
                          isEditing
                            ? editingText
                            : formatGrouped(row[field], isDecimal ? 2 : 0)
                        }
                        onFocus={() => {
                          setEditingField(cellKey);
                          setEditingText(
                            row[field] === ""
                              ? ""
                              : isDecimal
                                ? String(row[field]).replace(".", ",")
                                : String(row[field])
                          );
                        }}
                        onChange={(e) => updateCell(i, field, e.target.value)}
                        onBlur={() => setEditingField(null)}
                        onKeyDown={isDecimal ? amountKeyDown(editingText) : digitsOnlyKeyDown}
                        placeholder="0"
                        className="w-full box-border text-right text-[12.5px] rounded-[5px] border border-cellBorder px-1.5 py-1 disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                      />
                    );
                  })}
                </div>
              );
            })}

            <div className="grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 items-center pt-2.5 border-t-2 border-[#E4DFC8] text-[12.5px] font-bold">
              <div className="col-span-2">Итого</div>
              <div className="num">{totals.trafficPlan.toLocaleString("ru-RU")}</div>
              <div className="num">{totals.trafficFact.toLocaleString("ru-RU")}</div>
              <div className="num">{totals.instagram.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</div>
              <div className="num">{totals.tiktok.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</div>
              <div className="num">
                {totals.instagramPublic.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}
              </div>
              <div className="num">{totals.flyer.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</div>
              <div className="num">{totals.twoGis.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-borderSoft">
              <div className="text-[13px] text-muted">
                Итого расходов на маркетинг за месяц (по каналам):{" "}
                <span className="num text-ink font-bold">
                  {channelTotal.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₸
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!canEditSection || dirtyDayCount === 0 || savingDays}
                  onClick={handleSaveDayRows}
                  className={`text-[13px] font-bold rounded-lg px-4 py-2.5 transition-colors ${
                    dirtyDayCount > 0 && !savingDays
                      ? "bg-accent text-paper"
                      : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
                  }`}
                >
                  {savingDays ? "Сохраняем…" : justSavedDays ? "Сохранено" : "Сохранить трафик и каналы"}
                </button>
              </div>
            </div>
          </>
        )}
      </DataTableCard>

      <DataTableCard
        title="Дополнительные расходы на маркетинг"
        rows={expenses}
        getSearchText={(e) => `${e.date} ${e.category} ${e.comment}`}
        csvHeaders={["Дата", "Статья", "Сумма", "Комментарий"]}
        toCsvRow={(e) => [e.date, e.category, e.amount === "" ? 0 : e.amount, e.comment]}
        csvFilename={`expenses-${year}-${pad2(monthIndex + 1)}.csv`}
      >
        {(visibleExpenses) => (
          <>
            <div className="text-[12.5px] text-muted -mt-1">
              Сюда вносятся расходы, не относящиеся к таблице выше — по логике ДДС: дата, статья,
              сумма, комментарий.
            </div>

            <div className="grid grid-cols-[130px_220px_120px_1fr_110px] gap-3 pb-2.5 pt-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Дата</div>
              <div>Статья</div>
              <div>Сумма</div>
              <div>Комментарий</div>
              <div>Строка</div>
            </div>

            {visibleExpenses.map((e) => {
              const i = expenses.indexOf(e);
              const effectiveLocked = expenseEffectivelyLocked(e);
              const rowEditableInputs = canEditSection && !effectiveLocked;
              const showCountdown = !effectiveLocked && e.unlockExpiresAt;

              return (
                <div
                  key={e.id ?? `new-${i}`}
                  className="grid grid-cols-[130px_220px_120px_1fr_110px] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
                >
                  <input
                    type="date"
                    disabled={!rowEditableInputs}
                    value={e.date}
                    onChange={(ev) => updateExpense(i, "date", ev.target.value)}
                    className="w-full box-border rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                  />
                  <input
                    type="text"
                    disabled={!rowEditableInputs}
                    value={e.category}
                    onChange={(ev) => updateExpense(i, "category", ev.target.value)}
                    placeholder="Статья расхода"
                    className="w-full box-border rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                  />
                  {(() => {
                    const cellKey = `expense-${i}-amount`;
                    const isEditing = editingField === cellKey;
                    return (
                      <input
                        type="text"
                        inputMode="decimal"
                        disabled={!rowEditableInputs}
                        value={isEditing ? editingText : formatGrouped(e.amount, 2)}
                        onFocus={() => {
                          setEditingField(cellKey);
                          setEditingText(e.amount === "" ? "" : String(e.amount).replace(".", ","));
                        }}
                        onChange={(ev) => updateExpense(i, "amount", ev.target.value)}
                        onBlur={() => setEditingField(null)}
                        onKeyDown={amountKeyDown(editingText)}
                        placeholder="0"
                        className="w-full box-border text-right rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                      />
                    );
                  })()}
                  <input
                    type="text"
                    disabled={!rowEditableInputs}
                    value={e.comment}
                    onChange={(ev) => updateExpense(i, "comment", ev.target.value)}
                    placeholder="Комментарий"
                    className="w-full box-border rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                  />
                  <div className="flex flex-col items-end gap-0.5">
                    {effectiveLocked &&
                      (e.requestPending ? (
                        <span className="text-[11px] text-mutedLight italic">Ожидает</span>
                      ) : (
                        <button
                          type="button"
                          disabled={!canEditSection}
                          onClick={() => requestExpenseUnlock(e)}
                          className="text-[11px] font-semibold text-accent border border-accent rounded-md px-2 py-1 disabled:opacity-50"
                        >
                          Запрос
                        </button>
                      ))}
                    {showCountdown && (
                      <span className="text-[9.5px] text-mutedLight italic">
                        ещё {minutesLeft(e.unlockExpiresAt as string, nowTick)}м
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              disabled={!canEditSection}
              onClick={() => {
                const blank: ExpenseRow = { date: "", category: "", amount: "", comment: "", locked: false, requestPending: false, unlockExpiresAt: null };
                setExpenses((prev) => [...prev, blank]);
                setOriginalExpenses((prev) => [...prev, blank]);
              }}
              className="flex items-center gap-2 text-[13px] font-semibold text-accent py-3 text-left disabled:opacity-50"
            >
              + Добавить расход
            </button>

            <div className="flex items-center justify-between pt-2.5 border-t border-borderSoft text-[13px] font-bold">
              <span>Общая сумма расходов</span>
              <span className="num">{expensesTotal.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₸</span>
            </div>

            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={!canEditSection || dirtyExpenseCount === 0 || savingExpenses}
                onClick={handleSaveExpenses}
                className={`text-[13px] font-bold rounded-lg px-4 py-2.5 transition-colors ${
                  dirtyExpenseCount > 0 && !savingExpenses
                    ? "bg-accent text-paper"
                    : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
                }`}
              >
                {savingExpenses ? "Сохраняем…" : justSavedExpenses ? "Сохранено" : "Сохранить расходы"}
              </button>
            </div>
          </>
        )}
      </DataTableCard>
    </>
  );
}
