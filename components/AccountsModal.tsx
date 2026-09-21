"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";
import { recordLoginEvent } from "@/lib/loginEvents";
import { getErrorMessage } from "@/lib/errors";

// Accounts the user has manually signed into from this switcher, kept in
// this browser only (never sent to the server) so they can jump back in
// without re-typing a password each time — like switching profiles in
// TikTok. Only accounts added here ever show up; nothing is auto-added.
type SavedAccount = {
  id: string;
  email: string;
  fullName: string | null;
  accessToken: string;
  refreshToken: string;
};

const STORAGE_KEY = "overman.savedAccounts";

function readSaved(): SavedAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSaved(list: SavedAccount[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // private browsing / storage disabled — the switcher just won't persist
  }
}

function upsert(list: SavedAccount[], account: SavedAccount): SavedAccount[] {
  return [...list.filter((a) => a.id !== account.id), account];
}

function initialsOf(name: string | null, email: string | null) {
  const source = (name ?? "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }
  return (email ?? "?").slice(0, 2).toUpperCase();
}

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/invalid login credentials/i.test(message)) return "Неверный email или пароль.";
  if (/fetch|network|failed to fetch/i.test(message)) return "Нет связи с сервером. Проверьте интернет-соединение.";
  return message;
}

export default function AccountsModal({ onClose }: { onClose: () => void }) {
  const { isAdmin, permissions } = useAuth();
  const { requestNavigation } = useUnsavedChanges();
  const canEdit = isAdmin || permissions.accounts.canEdit;

  const [loading, setLoading] = useState(true);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedAccount[]>([]);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    setCurrentId(session?.user.id ?? null);
    setCurrentEmail(session?.user.email ?? null);

    let name: string | null = null;
    if (session) {
      const { data: roleRow } = await supabase
        .from("user_roles")
        .select("full_name")
        .eq("user_id", session.user.id)
        .maybeSingle();
      name = roleRow?.full_name ?? null;
    }
    setCurrentName(name);
    setSaved(readSaved().filter((a) => a.id !== session?.user.id));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Snapshots the session we're about to leave into local storage so it's
  // still reachable from the switcher after we move to a different account.
  async function persistCurrentSession() {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return;
    const list = upsert(readSaved(), {
      id: session.user.id,
      email: session.user.email ?? "",
      fullName: currentName,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    });
    writeSaved(list);
  }

  async function doSwitch(account: SavedAccount) {
    setSwitchingId(account.id);
    setError(null);
    try {
      await persistCurrentSession();

      const { data, error } = await supabase.auth.setSession({
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
      });
      if (error) throw error;
      if (!data.session) throw new Error("Не удалось переключить аккаунт.");

      writeSaved(
        upsert(readSaved(), {
          ...account,
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
        })
      );
      await recordLoginEvent(data.session.user.id, data.session.user.email ?? null);
      window.location.reload();
    } catch {
      setError(`Не удалось войти в ${account.email}. Возможно, сессия истекла — уберите аккаунт и добавьте его заново.`);
      setSwitchingId(null);
    }
  }

  async function doAdd() {
    setAddBusy(true);
    setAddError(null);
    try {
      await persistCurrentSession();

      const { data, error } = await supabase.auth.signInWithPassword({
        email: addEmail.trim(),
        password: addPassword,
      });
      if (error) throw error;
      if (!data.session) throw new Error("Не удалось войти.");

      writeSaved(
        upsert(readSaved(), {
          id: data.session.user.id,
          email: data.session.user.email ?? "",
          fullName: null,
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
        })
      );
      await recordLoginEvent(data.session.user.id, data.session.user.email ?? null);
      window.location.reload();
    } catch (e) {
      setAddError(friendlyError(e));
      setAddBusy(false);
    }
  }

  function handleSwitchClick(account: SavedAccount) {
    if (switchingId) return;
    requestNavigation(() => doSwitch(account));
  }

  function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (addBusy) return;
    requestNavigation(() => doAdd());
  }

  function handleRemove(id: string) {
    const list = readSaved().filter((a) => a.id !== id);
    writeSaved(list);
    setSaved(list.filter((a) => a.id !== currentId));
  }

  return (
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-card p-6 max-w-sm w-full flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-[15px] font-bold text-ink">Аккаунты</div>
          <button type="button" onClick={onClose} className="text-[13px] font-semibold text-muted hover:text-ink">
            Закрыть
          </button>
        </div>

        {error && <div className="text-sm text-[#A34B36]">{error}</div>}

        {loading ? (
          <div className="text-sm text-muted">Загрузка…</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-3 px-2 py-2 rounded-md bg-paper">
              <div className="w-8 h-8 rounded-full bg-accent text-paper text-[12px] font-bold flex items-center justify-center flex-none">
                {initialsOf(currentName, currentEmail)}
              </div>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[13px] font-semibold text-ink truncate">{currentName || "Без имени"}</span>
                <span className="text-[11.5px] text-mutedLight truncate">{currentEmail}</span>
              </div>
              <span className="text-[10px] uppercase tracking-wide text-accent font-bold flex-none">Текущий</span>
            </div>

            {saved.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-2 py-1 rounded-md hover:bg-paper">
                <div className="w-8 h-8 rounded-full bg-mutedLight text-paper text-[12px] font-bold flex items-center justify-center flex-none">
                  {initialsOf(a.fullName, a.email)}
                </div>
                <button
                  type="button"
                  onClick={() => handleSwitchClick(a)}
                  disabled={switchingId === a.id}
                  className="flex flex-col min-w-0 flex-1 text-left py-1 disabled:opacity-50"
                >
                  <span className="text-[13px] font-semibold text-ink truncate">{a.fullName || "Без имени"}</span>
                  <span className="text-[11.5px] text-mutedLight truncate">
                    {switchingId === a.id ? "Переключаем…" : a.email}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(a.id)}
                  title="Убрать из списка"
                  className="text-mutedLight hover:text-[#A34B36] text-[15px] leading-none flex-none px-1.5 py-1"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {canEdit && (
          <div className="pt-3 border-t border-borderSoft">
            {adding ? (
              <form onSubmit={handleAddSubmit} className="flex flex-col gap-2">
                <input
                  type="email"
                  required
                  placeholder="Email"
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  className="text-[13px] rounded-lg border border-border bg-surface text-ink px-3 py-2 focus:outline-none focus:border-accent"
                />
                <input
                  type="password"
                  required
                  placeholder="Пароль"
                  value={addPassword}
                  onChange={(e) => setAddPassword(e.target.value)}
                  className="text-[13px] rounded-lg border border-border bg-surface text-ink px-3 py-2 focus:outline-none focus:border-accent"
                />
                {addError && <div className="text-[12.5px] text-[#A34B36]">{addError}</div>}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      setAddError(null);
                      setAddEmail("");
                      setAddPassword("");
                    }}
                    disabled={addBusy}
                    className="text-[13px] font-semibold text-muted px-3.5 py-2 rounded-lg hover:bg-paper disabled:opacity-50"
                  >
                    Отмена
                  </button>
                  <button
                    type="submit"
                    disabled={addBusy}
                    className="text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2 disabled:opacity-50"
                  >
                    {addBusy ? "Входим…" : "Войти"}
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2.5"
              >
                + Добавить аккаунт
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
