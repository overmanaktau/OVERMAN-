"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { authFetch } from "@/lib/apiClient";
import { getErrorMessage } from "@/lib/errors";

type Account = {
  id: string;
  email: string;
  fullName: string | null;
  role: "admin" | "editor" | null;
};

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером. Проверьте интернет-соединение и попробуйте снова.";
  }
  return `Не удалось выполнить операцию: ${message}`;
}

export default function AccountsModal({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ data: userData }, data] = await Promise.all([supabase.auth.getUser(), authFetch("/api/accounts")]);
      setSelfId(userData.user?.id ?? null);
      setAccounts(data.employees ?? []);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startSelecting() {
    setSelecting(true);
    setSelected(new Set());
  }

  function cancelSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  async function handleDelete() {
    if (selected.size === 0) return;
    if (!window.confirm(`Удалить ${selected.size} аккаунт(ов)? Это действие нельзя отменить.`)) return;

    setDeleting(true);
    setError(null);
    try {
      for (const id of selected) {
        await authFetch(`/api/accounts/${id}`, { method: "DELETE" });
      }
      setSelecting(false);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-card p-6 max-w-md w-full max-h-[80vh] flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between flex-none">
          <div className="text-[15px] font-bold text-ink">Аккаунты</div>
          <button type="button" onClick={onClose} className="text-[13px] font-semibold text-muted hover:text-ink">
            Закрыть
          </button>
        </div>

        {error && <div className="text-sm text-[#A34B36] flex-none">{error}</div>}

        <div className="flex-1 overflow-y-auto flex flex-col gap-0.5 -mx-1 px-1">
          {loading ? (
            <div className="text-sm text-muted">Загрузка…</div>
          ) : accounts.length === 0 ? (
            <div className="text-sm text-muted">Аккаунтов нет.</div>
          ) : (
            accounts.map((a) => {
              const isSelf = a.id === selfId;
              return (
                <label
                  key={a.id}
                  className={`flex items-center gap-3 px-2 py-2 rounded-md ${
                    selecting && !isSelf ? "cursor-pointer hover:bg-paper" : ""
                  }`}
                >
                  {selecting && (
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      disabled={isSelf}
                      onChange={() => toggle(a.id)}
                      className="accent-accent disabled:opacity-30 flex-none"
                    />
                  )}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[13px] font-semibold text-ink truncate">{a.fullName || "Без имени"}</span>
                    <span className="text-[11.5px] text-mutedLight truncate">{a.email}</span>
                  </div>
                  <span className="text-[11px] text-muted flex-none">
                    {a.role === "admin" ? "Администратор" : "Сотрудник"}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-borderSoft flex-none">
          {selecting ? (
            <>
              <button
                type="button"
                onClick={cancelSelecting}
                disabled={deleting}
                className="text-[13px] font-semibold text-muted px-3.5 py-2 rounded-lg hover:bg-paper disabled:opacity-50"
              >
                Отменить
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || deleting}
                onClick={handleDelete}
                className="text-[13px] font-bold text-paper bg-[#A34B36] rounded-lg px-4 py-2 disabled:opacity-50"
              >
                {deleting ? "Удаляем…" : `Удалить${selected.size ? ` (${selected.size})` : ""}`}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={loading || accounts.length === 0}
              onClick={startSelecting}
              className="text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2 disabled:opacity-50"
            >
              Выбрать
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
