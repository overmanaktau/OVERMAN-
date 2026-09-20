"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";
import { getErrorMessage } from "@/lib/errors";

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

const DB_FIELD = {
  trafficPlan: "traffic_plan",
  trafficFact: "traffic_fact",
  instagram: "instagram",
  tiktok: "tiktok",
  instagramPublic: "instagram_public",
  flyer: "flyer",
  twoGis: "two_gis",
} as const;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function ymd(year: number, monthIndex: number, day: number) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером базы данных. Проверьте интернет-соединение и попробуйте снова.";
  }
  if (/JWT|session|401|403/i.test(message)) {
    return "Сессия истекла или нет доступа. Попробуйте выйти и войти снова.";
  }
  return `Не удалось выполнить операцию: ${message}`;
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

export default function DataEntryPage() {
  const { isAdmin, permissions, cities, stores, accessibleStoreCodes } = useAuth();
  const canView = isAdmin || permissions["marketing.data_entry"].canView;
  const canEditSection = isAdmin || permissions["marketing.data_entry"].canEdit;
  // Locking/unlocking the month follows the same edit permission as the data
  // itself — no separate admin-only gate; restrict a role via its edit checkbox instead.
  const canEditLocked = canEditSection;

  const accessibleStores = stores.filter((s) => accessibleStoreCodes.includes(s.code));
  const accessibleCities = useMemo(
    () => cities.filter((c) => accessibleStores.some((s) => s.city_id === c.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cities, accessibleStores.map((s) => s.code).join(",")]
  );

  const [store, setStore] = useState<string>("");
  const [cityId, setCityId] = useState<number | "">("");

  useEffect(() => {
    if (!store && accessibleStores.length > 0) setStore(accessibleStores[0].code);
    else if (store && !accessibleStoreCodes.includes(store) && accessibleStores.length > 0) {
      setStore(accessibleStores[0].code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessibleStoreCodes.join(",")]);

  // The city dropdown always reflects whichever store is actually active —
  // it's a navigation aid for narrowing the store list, not separate state.
  useEffect(() => {
    const current = accessibleStores.find((s) => s.code === store);
    if (current && current.city_id !== cityId) setCityId(current.city_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, accessibleStores.map((s) => s.code).join(",")]);

  const storesForCity = useMemo(
    () => accessibleStores.filter((s) => s.city_id === cityId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessibleStores.map((s) => s.code).join(","), cityId]
  );

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIndex, setMonthIndex] = useState(today.getMonth());

  const [rows, setRows] = useState<DayRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [locked, setLocked] = useState(false);
  const [monthStatusId, setMonthStatusId] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const editable = canEditSection && (!locked || canEditLocked);
  const { setGuard, requestNavigation } = useUnsavedChanges();

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);

    try {
      const firstStr = ymd(year, monthIndex, 1);
      const lastStr = ymd(year, monthIndex, daysInMonth(year, monthIndex));

      const [entriesRes, statusRes, expensesRes] = await Promise.all([
        supabase
          .from("traffic_entries")
          .select("*")
          .eq("store", store)
          .gte("entry_date", firstStr)
          .lte("entry_date", lastStr),
        supabase.from("month_status").select("*").eq("store", store).eq("month", firstStr).maybeSingle(),
        supabase
          .from("extra_expenses")
          .select("*")
          .gte("expense_date", firstStr)
          .lte("expense_date", lastStr)
          .order("expense_date"),
      ]);

      const firstError = entriesRes.error || statusRes.error || expensesRes.error;
      if (firstError) throw firstError;

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

      setRows(merged);
      setLocked(statusRes.data?.locked ?? false);
      setMonthStatusId(statusRes.data?.id ?? null);
      setExpenses(
        (expensesRes.data ?? []).map((e) => ({
          id: e.id,
          date: e.expense_date,
          category: e.category ?? "",
          amount: e.amount ?? "",
          comment: e.comment ?? "",
        }))
      );
      setDirty(false);
    } catch (e) {
      setError(friendlyError(e));
      setRows(buildMonthRows(year, monthIndex));
      setExpenses([]);
      setDirty(false);
    } finally {
      setLoading(false);
    }
  }, [year, monthIndex, store]);

  useEffect(() => {
    load();
  }, [load]);

  function shiftMonth(delta: number) {
    const doShift = () => {
      const total = year * 12 + monthIndex + delta;
      setYear(Math.floor(total / 12));
      setMonthIndex(((total % 12) + 12) % 12);
    };
    if (dirty) requestNavigation(doShift);
    else doShift();
  }

  function changeStore(nextStore: string) {
    const doChange = () => setStore(nextStore);
    if (dirty) requestNavigation(doChange);
    else doChange();
  }

  function changeCity(nextCityId: number) {
    const firstStore = accessibleStores.find((s) => s.city_id === nextCityId);
    if (!firstStore) return;
    const doChange = () => {
      setCityId(nextCityId);
      setStore(firstStore.code);
    };
    if (dirty) requestNavigation(doChange);
    else doChange();
  }

  function updateCell(index: number, field: (typeof NUMERIC_FIELDS)[number], value: string) {
    if (!editable) return;
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value === "" ? "" : Number(value) };
      return next;
    });
    setDirty(true);
  }

  function updateExpense(index: number, field: keyof ExpenseRow, value: string) {
    if (!editable) return;
    setExpenses((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        [field]: field === "amount" ? (value === "" ? "" : Number(value)) : value,
      };
      return next;
    });
    setDirty(true);
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

  async function handleSave() {
    if (saving) return; // guards against a second click landing before the button disables
    setSaving(true);
    setError(null);
    try {
      const nextRows = [...rows];
      for (let i = 0; i < nextRows.length; i++) {
        const row = nextRows[i];
        const hasData = NUMERIC_FIELDS.some((f) => row[f] !== "");
        if (!row.id && !hasData) continue;

        const payload: Record<string, unknown> = { store, entry_date: row.entryDate };
        for (const f of NUMERIC_FIELDS) payload[DB_FIELD[f]] = row[f] === "" ? null : row[f];

        if (row.id) {
          const { error } = await supabase.from("traffic_entries").update(payload).eq("id", row.id);
          if (error) throw error;
        } else {
          const { data, error } = await supabase
            .from("traffic_entries")
            .insert(payload)
            .select("id")
            .single();
          if (error) throw error;
          nextRows[i] = { ...row, id: data.id };
        }
      }

      const nextExpenses = [...expenses];
      for (let i = 0; i < nextExpenses.length; i++) {
        const exp = nextExpenses[i];
        if (!exp.id && !exp.date && !exp.category && exp.amount === "") continue;

        const payload = {
          expense_date: exp.date || null,
          category: exp.category,
          amount: exp.amount === "" ? 0 : exp.amount,
          comment: exp.comment,
        };

        if (exp.id) {
          const { error } = await supabase.from("extra_expenses").update(payload).eq("id", exp.id);
          if (error) throw error;
        } else {
          const { data, error } = await supabase
            .from("extra_expenses")
            .insert(payload)
            .select("id")
            .single();
          if (error) throw error;
          nextExpenses[i] = { ...exp, id: data.id };
        }
      }

      const firstStr = ymd(year, monthIndex, 1);
      if (monthStatusId) {
        const { error } = await supabase.from("month_status").update({ locked: true }).eq("id", monthStatusId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("month_status")
          .insert({ store, month: firstStr, locked: true })
          .select("id")
          .single();
        if (error) throw error;
        setMonthStatusId(data.id);
      }

      setRows(nextRows);
      setExpenses(nextExpenses);
      setLocked(true);
      setDirty(false);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const active = dirty && editable;
    setGuard(active, active ? { onSave: () => saveRef.current(), onDiscard: () => loadRef.current() } : null);
    return () => setGuard(false, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, editable]);

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
        <div className="flex items-center gap-2.5">
          <h1 className="font-serif text-[28px] font-semibold m-0">Внесение данных</h1>
          {locked && (
            <span className="text-[11px] tracking-wide uppercase text-muted bg-[#EDE8DC] border border-border rounded-full px-2.5 py-1">
              месяц закрыт
            </span>
          )}
        </div>
        <p className="text-sm text-muted max-w-xl mt-1">
          Трафик и расходы по каналам вводятся вручную за каждый день. Сохранить месяц и снова
          открыть его для правок может любой пользователь с правом редактирования этого раздела.
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
            value={cityId}
            onChange={(e) => changeCity(Number(e.target.value))}
            disabled={loading || accessibleCities.length <= 1}
            className="text-[13px] font-semibold bg-surface border border-border rounded-lg px-3 py-2 disabled:opacity-70"
          >
            {accessibleCities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={store}
            onChange={(e) => changeStore(e.target.value)}
            disabled={loading || storesForCity.length <= 1}
            className="text-[13px] font-semibold bg-surface border border-border rounded-lg px-3 py-2 disabled:opacity-70"
          >
            {storesForCity.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-card px-6 pt-[22px] pb-5 flex flex-col gap-3.5">
        <div className="text-[15px] font-bold">
          Трафик и расходы по каналам — {MONTH_NAMES[monthIndex].toLowerCase()} {year}
        </div>

        <div className="max-h-[460px] overflow-y-auto rounded-md">
          <div className="sticky top-0 z-10 bg-surface grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
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

          {rows.map((row, i) => (
            <div
              key={row.entryDate}
              className={`grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 items-center py-1 border-b border-borderSoft ${
                row.weekend ? "bg-weekendTint" : ""
              }`}
            >
              <div className="text-[12.5px] text-muted">{row.date}</div>
              <div className="text-[12.5px] text-mutedLight">{row.weekday}</div>
              {NUMERIC_FIELDS.map((field) => (
                <input
                  key={field}
                  type="number"
                  disabled={!editable}
                  value={row[field] === "" ? "" : (row[field] as number)}
                  onChange={(e) => updateCell(i, field, e.target.value)}
                  placeholder="0"
                  className="w-full box-border text-right text-[12.5px] rounded-[5px] border border-cellBorder px-1.5 py-1 disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                />
              ))}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 items-center pt-2.5 border-t-2 border-[#E4DFC8] text-[12.5px] font-bold">
          <div className="col-span-2">Итого</div>
          <div className="num">{totals.trafficPlan || 0}</div>
          <div className="num">{totals.trafficFact || 0}</div>
          <div className="num">{totals.instagram.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.tiktok.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.instagramPublic.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.flyer.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.twoGis.toLocaleString("ru-RU")}</div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-borderSoft">
          <div className="text-[13px] text-muted">
            Итого расходов на маркетинг за месяц (по каналам):{" "}
            <span className="num text-ink font-bold">{channelTotal.toLocaleString("ru-RU")} ₸</span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={!editable || saving || loading}
              onClick={load}
              className="text-[13px] font-semibold text-muted border border-[#DDD6C8] rounded-lg px-4 py-2.5 disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={!editable || saving || loading}
              onClick={handleSave}
              className="text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
            >
              {saving ? "Сохраняем…" : locked ? "Месяц сохранён" : "Сохранить месяц"}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        <div className="flex flex-col gap-0.5">
          <div className="text-[15px] font-bold">Дополнительные расходы на маркетинг</div>
          <div className="text-[12.5px] text-muted">
            Сюда вносятся расходы, не относящиеся к таблице выше — по логике ДДС: дата, статья,
            сумма, комментарий.
          </div>
        </div>

        <div className="grid grid-cols-[130px_220px_120px_1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
          <div>Дата</div>
          <div>Статья</div>
          <div>Сумма</div>
          <div>Комментарий</div>
        </div>

        {expenses.map((e, i) => (
          <div
            key={e.id ?? `new-${i}`}
            className="grid grid-cols-[130px_220px_120px_1fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
          >
            <input
              type="date"
              disabled={!editable}
              value={e.date}
              onChange={(ev) => updateExpense(i, "date", ev.target.value)}
              className="w-full box-border rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
            />
            <input
              type="text"
              disabled={!editable}
              value={e.category}
              onChange={(ev) => updateExpense(i, "category", ev.target.value)}
              placeholder="Статья расхода"
              className="w-full box-border rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
            />
            <input
              type="number"
              disabled={!editable}
              value={e.amount === "" ? "" : e.amount}
              onChange={(ev) => updateExpense(i, "amount", ev.target.value)}
              placeholder="0"
              className="w-full box-border text-right rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
            />
            <input
              type="text"
              disabled={!editable}
              value={e.comment}
              onChange={(ev) => updateExpense(i, "comment", ev.target.value)}
              placeholder="Комментарий"
              className="w-full box-border rounded-[5px] border border-cellBorder px-1.5 py-1 text-[12.5px] disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
            />
          </div>
        ))}

        <button
          type="button"
          disabled={!editable}
          onClick={() => {
            setExpenses((prev) => [...prev, { date: "", category: "", amount: "", comment: "" }]);
            setDirty(true);
          }}
          className="flex items-center gap-2 text-[13px] font-semibold text-accent py-3 text-left disabled:opacity-50"
        >
          + Добавить расход
        </button>

        <div className="flex items-center justify-between pt-2.5 border-t border-borderSoft text-[13px] font-bold">
          <span>Общая сумма расходов</span>
          <span className="num">{expensesTotal.toLocaleString("ru-RU")} ₸</span>
        </div>
      </div>
    </>
  );
}
