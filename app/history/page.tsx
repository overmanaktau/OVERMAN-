"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { authFetch } from "@/lib/apiClient";
import PeriodFilterBar, { type PeriodMode } from "@/components/PeriodFilterBar";
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

export default function HistoryPage() {
  const [rows, setRows] = useState<EditHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [periodMode, setPeriodMode] = useState<PeriodMode>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [rosterNames, setRosterNames] = useState<string[]>([]);

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
      .then((data) => setRosterNames((data.names ?? []) as string[]))
      .catch(() => {
        // non-fatal — the filter just falls back to names already present in the loaded history
      });
  }, []);

  // Every current employee shows up here, even with zero history yet, plus
  // anyone who only appears in the history because they've since been deleted.
  const employees = useMemo(
    () =>
      Array.from(new Set([...rosterNames, ...rows.map((r) => r.changed_by_name)])).sort((a, b) =>
        a.localeCompare(b, "ru")
      ),
    [rows, rosterNames]
  );

  const visibleRows = useMemo(() => {
    return rows.filter((r) => {
      if (employeeFilter !== "all" && r.changed_by_name !== employeeFilter) return false;
      if (periodMode === "custom") {
        const d = r.created_at.slice(0, 10);
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
      }
      return true;
    });
  }, [rows, employeeFilter, periodMode, dateFrom, dateTo]);

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
        <select
          value={employeeFilter}
          onChange={(e) => setEmployeeFilter(e.target.value)}
          className="text-[13px] font-semibold bg-surface border border-border rounded-lg px-3 py-2.5"
        >
          <option value="all">Все сотрудники</option>
          {employees.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        {loading ? (
          <div className="text-sm text-muted">Загрузка…</div>
        ) : visibleRows.length === 0 ? (
          <div className="text-sm text-muted">
            {rows.length === 0 ? "Изменений пока нет." : "За выбранный период и сотрудника изменений нет."}
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[130px_150px_150px_1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Дата</div>
              <div>Кто</div>
              <div>Раздел</div>
              <div>Что изменил</div>
            </div>
            {visibleRows.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[130px_150px_150px_1fr] gap-3 py-2.5 border-b border-borderSoft items-start text-[13px]"
              >
                <div className="text-muted">{formatDateTime(r.created_at)}</div>
                <div className="font-semibold">{r.changed_by_name}</div>
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
