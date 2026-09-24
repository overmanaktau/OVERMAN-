"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { authFetch } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthGate";
import PeriodFilterBar, { type PeriodMode } from "@/components/PeriodFilterBar";
import { getErrorMessage } from "@/lib/errors";

type EditRequest = {
  id: number;
  table_name: "traffic_entries" | "extra_expenses";
  row_id: number | null;
  store: string | null;
  context: string | null;
  requested_by: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
};

const TABLE_LABEL: Record<EditRequest["table_name"], string> = {
  traffic_entries: "Трафик и каналы",
  extra_expenses: "Доп. расходы",
};

const STATUS_LABEL: Record<EditRequest["status"], string> = {
  pending: "Ожидает",
  approved: "Одобрено",
  denied: "Отказано",
};

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером базы данных. Проверьте интернет-соединение и попробуйте снова.";
  }
  return `Не удалось выполнить операцию: ${message}`;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function RequestsPage() {
  const { isAdmin, permissions } = useAuth();
  const canAct = isAdmin || permissions["requests"].canEdit;
  const [requests, setRequests] = useState<EditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioning, setActioning] = useState<Record<number, boolean>>({});

  const [showHistory, setShowHistory] = useState(false);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from("edit_requests")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setRequests((data ?? []) as EditRequest[]);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visibleRequests = useMemo(() => {
    if (!showHistory || periodMode === "all") return requests;
    return requests.filter((r) => {
      const d = r.created_at.slice(0, 10);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });
  }, [requests, showHistory, periodMode, dateFrom, dateTo]);

  async function act(id: number, action: "approve" | "deny") {
    setActioning((prev) => ({ ...prev, [id]: true }));
    setError(null);
    try {
      await authFetch(`/api/edit-requests/${id}/${action}`, { method: "POST" });
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setActioning((prev) => ({ ...prev, [id]: false }));
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Общее</div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-serif text-[28px] font-semibold m-0">Запросы</h1>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className={`text-[13px] font-semibold rounded-lg px-3.5 py-2 ${
              showHistory ? "bg-accent text-paper" : "bg-surface border border-border text-muted"
            }`}
          >
            История запросов
          </button>
        </div>
        <p className="text-sm text-muted max-w-xl mt-1">
          {canAct
            ? "Здесь появляются запросы на повторное изменение уже сохранённой строки. Одобрите или отклоните каждый запрос."
            : "Здесь отображаются ваши запросы на повторное изменение уже сохранённой строки и их статус."}
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

      {showHistory && (
        <PeriodFilterBar
          mode={periodMode}
          onModeChange={setPeriodMode}
          dateFrom={dateFrom}
          onDateFromChange={setDateFrom}
          dateTo={dateTo}
          onDateToChange={setDateTo}
        />
      )}

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        {loading ? (
          <div className="text-sm text-muted">Загрузка…</div>
        ) : visibleRequests.length === 0 ? (
          <div className="text-sm text-muted">{showHistory ? "За этот период запросов нет." : "Запросов пока нет."}</div>
        ) : (
          <div className="overflow-x-auto flex flex-col">
            <div
              className={`min-w-[640px] grid ${
                canAct ? "grid-cols-[130px_150px_1fr_120px_170px]" : "grid-cols-[130px_150px_1fr_120px]"
              } gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border`}
            >
              <div>Дата запроса</div>
              <div>Раздел</div>
              <div>Строка</div>
              <div>Статус</div>
              {canAct && <div>Действия</div>}
            </div>
            {visibleRequests.map((r) => (
              <div
                key={r.id}
                className={`min-w-[640px] grid ${
                  canAct ? "grid-cols-[130px_150px_1fr_120px_170px]" : "grid-cols-[130px_150px_1fr_120px]"
                } gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]`}
              >
                <div className="text-muted">{formatDateTime(r.created_at)}</div>
                <div>{TABLE_LABEL[r.table_name]}</div>
                <div className="text-muted">{r.context ?? "—"}</div>
                <div>
                  <span
                    className={`text-[11px] font-semibold uppercase tracking-wide rounded-full px-2.5 py-1 ${
                      r.status === "pending"
                        ? "bg-[#EDE8DC] text-muted"
                        : r.status === "approved"
                        ? "bg-[#DDEBD9] text-[#3E6B44]"
                        : "bg-[#F2DCD5] text-[#A34B36]"
                    }`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                  {r.status !== "pending" && r.reviewed_by_name && (
                    <div className="text-[10.5px] text-mutedLight mt-1">
                      {r.reviewed_by_name}
                      {r.reviewed_at ? `, ${formatDateTime(r.reviewed_at)}` : ""}
                    </div>
                  )}
                </div>
                {canAct && (
                  <div className="flex items-center gap-2">
                    {r.status === "pending" ? (
                      <>
                        <button
                          type="button"
                          disabled={actioning[r.id]}
                          onClick={() => act(r.id, "approve")}
                          className="text-[12.5px] font-bold text-paper bg-accent rounded-lg px-3 py-1.5 disabled:opacity-50"
                        >
                          Одобрить
                        </button>
                        <button
                          type="button"
                          disabled={actioning[r.id]}
                          onClick={() => act(r.id, "deny")}
                          className="text-[12.5px] font-semibold text-[#A34B36] border border-[#DDD6C8] rounded-lg px-3 py-1.5 disabled:opacity-50"
                        >
                          Отклонить
                        </button>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
