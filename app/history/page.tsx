"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { authFetch } from "@/lib/apiClient";
import PeriodFilterBar, { type PeriodMode } from "@/components/PeriodFilterBar";
import { useSiteVersion } from "@/components/SiteVersion";
import { getErrorMessage } from "@/lib/errors";

type EditHistoryRow = {
  id: number;
  table_name: "traffic_entries" | "extra_expenses";
  row_id: number;
  store: string | null;
  summary: string;
  changed_by: string | null;
  changed_by_name: string;
  created_at: string;
};

const TABLE_LABEL: Record<EditHistoryRow["table_name"], string> = {
  traffic_entries: "Трафик и каналы",
  extra_expenses: "Доп. расходы",
};

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером базы данных. Проверьте интернет-соединение и попробуйте снова.";
  }
  return `Не удалось загрузить историю: ${message}`;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Custom dropdown instead of a plain <select> so "Удалённые сотрудники" can
// be its own collapsed-by-default disclosure — a native <optgroup> label
// isn't clickable and shows every deleted account the moment the list
// opens, right alongside people who currently work here.
function EmployeeFilter({
  value,
  onChange,
  currentNames,
  deletedNames,
}: {
  value: string;
  onChange: (name: string) => void;
  currentNames: string[];
  deletedNames: string[];
}) {
  const [open, setOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setDeletedOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function pick(name: string) {
    onChange(name);
    setOpen(false);
    setDeletedOpen(false);
  }

  const itemClass = (active: boolean) =>
    `w-full text-left text-[13px] px-3 py-1.5 rounded-md hover:bg-paper ${active ? "text-accent font-bold" : "text-ink"}`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[13px] font-semibold bg-surface border border-border rounded-lg px-3 py-2.5"
      >
        {value === "all" ? "Все сотрудники" : value}
        <span className="text-mutedLight text-[10px]">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-30 bg-surface border border-border rounded-lg shadow-lg p-1.5 w-[240px] max-w-[calc(100vw-2rem)] max-h-[360px] overflow-y-auto flex flex-col gap-0.5">
          <button type="button" onClick={() => pick("all")} className={itemClass(value === "all")}>
            Все сотрудники
          </button>
          {currentNames.map((name) => (
            <button key={name} type="button" onClick={() => pick(name)} className={itemClass(value === name)}>
              {name}
            </button>
          ))}
          {deletedNames.length > 0 && (
            <>
              <div className="h-px bg-border my-1" />
              <button
                type="button"
                onClick={() => setDeletedOpen((v) => !v)}
                className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-mutedLight px-3 py-1.5 rounded-md hover:bg-paper"
              >
                Удалённые сотрудники
                <span className="text-[9px]">{deletedOpen ? "▴" : "▾"}</span>
              </button>
              {deletedOpen &&
                deletedNames.map((name) => (
                  <button key={name} type="button" onClick={() => pick(name)} className={itemClass(value === name) + " pl-5"}>
                    {name}
                  </button>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  const { mobileLayout } = useSiteVersion();
  const [rows, setRows] = useState<EditHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [periodMode, setPeriodMode] = useState<PeriodMode>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from("edit_history")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setRows((data ?? []) as EditHistoryRow[]);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    authFetch("/api/history-employees")
      .then((data) => setRoster((data.roster ?? []) as { id: string; name: string }[]))
      .catch(() => {
        // non-fatal — the filter just falls back to names already present in the loaded history
      });
  }, []);

  // changed_by_name is a text snapshot taken when the row was written — if
  // someone's full_name is edited later (or was entered inconsistently, e.g.
  // "Кайнар" vs "Рахашев Кайнар"), old rows stay stuck under the stale name
  // forever, fragmenting one person into several filter entries. Resolving
  // by changed_by (a stable user id) against the CURRENT roster fixes that;
  // the stored name is only a fallback for someone no longer employed.
  const nameById = useMemo(() => new Map(roster.map((e) => [e.id, e.name])), [roster]);
  const resolveName = useCallback(
    (r: EditHistoryRow) => (r.changed_by && nameById.get(r.changed_by)) || r.changed_by_name,
    [nameById]
  );

  // Split into two groups for the filter dropdown: every current employee
  // (even with zero history yet), and separately anyone who only appears in
  // the history because they've since been deleted — kept apart so a
  // growing pile of ex-employees doesn't clutter the list of people who
  // actually work here now.
  const currentNames = useMemo(
    () => Array.from(new Set(roster.map((e) => e.name))).sort((a, b) => a.localeCompare(b, "ru")),
    [roster]
  );
  const deletedNames = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows) {
      if (!r.changed_by || !nameById.has(r.changed_by)) names.add(r.changed_by_name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, "ru"));
  }, [rows, nameById]);

  const visibleRows = useMemo(() => {
    return rows.filter((r) => {
      if (employeeFilter !== "all" && resolveName(r) !== employeeFilter) return false;
      if (periodMode === "custom") {
        const d = r.created_at.slice(0, 10);
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
      }
      return true;
    });
  }, [rows, employeeFilter, periodMode, dateFrom, dateTo, resolveName]);

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Общее</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">История</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Здесь показываются повторные изменения уже сохранённых строк — кто, что и когда изменил.
          Первое внесение данных сюда не попадает.
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

      <div className="flex items-center gap-3 flex-wrap">
        <PeriodFilterBar
          mode={periodMode}
          onModeChange={setPeriodMode}
          dateFrom={dateFrom}
          onDateFromChange={setDateFrom}
          dateTo={dateTo}
          onDateToChange={setDateTo}
        />
        <EmployeeFilter
          value={employeeFilter}
          onChange={setEmployeeFilter}
          currentNames={currentNames}
          deletedNames={deletedNames}
        />
      </div>

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        {loading ? (
          <div className="text-sm text-muted">Загрузка…</div>
        ) : visibleRows.length === 0 ? (
          <div className="text-sm text-muted">
            {rows.length === 0 ? "Изменений пока нет." : "За выбранный период и сотрудника изменений нет."}
          </div>
        ) : mobileLayout ? (
          <div className="flex flex-col gap-2.5">
            {visibleRows.map((r) => (
              <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{resolveName(r)}</span>
                  <span className="text-mutedLight text-[11px]">{formatDateTime(r.created_at)}</span>
                </div>
                <div className="text-mutedLight text-[11px] uppercase tracking-wide">{TABLE_LABEL[r.table_name]}</div>
                <div className="text-muted">{r.summary}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto flex flex-col">
            <div className="min-w-[640px] grid grid-cols-[130px_150px_150px_1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Дата</div>
              <div>Кто</div>
              <div>Раздел</div>
              <div>Что изменил</div>
            </div>
            {visibleRows.map((r) => (
              <div
                key={r.id}
                className="min-w-[640px] grid grid-cols-[130px_150px_150px_1fr] gap-3 py-2.5 border-b border-borderSoft items-start text-[13px]"
              >
                <div className="text-muted">{formatDateTime(r.created_at)}</div>
                <div className="font-semibold">{resolveName(r)}</div>
                <div className="text-muted">{TABLE_LABEL[r.table_name]}</div>
                <div className="text-muted">{r.summary}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
