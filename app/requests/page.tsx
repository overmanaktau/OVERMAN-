"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { authFetch } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthGate";
import { getErrorMessage } from "@/lib/errors";

type EditRequest = {
  id: number;
  table_name: "traffic_entries" | "extra_expenses";
  row_id: number;
  store: string | null;
  context: string | null;
  requested_by: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  reviewed_at: string | null;
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
        <h1 className="font-serif text-[28px] font-semibold m-0">Запросы</h1>
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

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        {loading ? (
          <div className="text-sm text-muted">Загрузка…</div>
        ) : requests.length === 0 ? (
          <div className="text-sm text-muted">Запросов пока нет.</div>
        ) : (
          <div className="flex flex-col">
            <div
              className={`grid ${
                canAct ? "grid-cols-[130px_150px_1fr_120px_170px]" : "grid-cols-[130px_150px_1fr_120px]"
              } gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border`}
            >
              <div>Дата запроса</div>
              <div>Раздел</div>
              <div>Строка</div>
              <div>Статус</div>
              {canAct && <div>Действия</div>}
            </div>
            {requests.map((r) => (
              <div
                key={r.id}
                className={`grid ${
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
