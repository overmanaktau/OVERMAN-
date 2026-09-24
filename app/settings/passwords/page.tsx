"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

type StoredPassword = {
  id: number;
  social_network: string;
  login: string;
  password: string;
  label: string | null;
  created_by_name: string | null;
  created_at: string;
};

function IconEye() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconEyeOff() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61C3.87 8.36 2 11 1 12c0 0 4 7 11 7a10.9 10.9 0 0 0 5.39-1.61M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

export default function PasswordsPage() {
  const { isAdmin, permissions, fullName, email } = useAuth();
  const canView = isAdmin || permissions["settings.passwords"].canView;
  const canEdit = isAdmin || permissions["settings.passwords"].canEdit;

  const [passwords, setPasswords] = useState<StoredPassword[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  const [newNetwork, setNewNetwork] = useState("");
  const [newLogin, setNewLogin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from("stored_passwords")
        .select("*")
        .order("social_network")
        .order("created_at");
      if (error) throw error;
      setPasswords((data ?? []) as StoredPassword[]);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleReveal(id: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const network = newNetwork.trim();
    const login = newLogin.trim();
    const password = newPassword.trim();
    if (!network || !login || !password) return;
    setAdding(true);
    setError(null);
    try {
      const { error } = await supabase.from("stored_passwords").insert({
        social_network: network,
        login,
        password,
        label: newLabel.trim() || null,
        created_by_name: fullName || email,
      });
      if (error) throw error;
      setNewNetwork("");
      setNewLogin("");
      setNewPassword("");
      setNewLabel("");
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Удалить этот аккаунт из списка паролей?")) return;
    setError(null);
    try {
      const { error } = await supabase.from("stored_passwords").delete().eq("id", id);
      if (error) throw error;
      setPasswords((prev) => prev.filter((p) => p.id !== id));
      setRevealed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Пароли».</p>
      </div>
    );
  }

  const byNetwork = new Map<string, StoredPassword[]>();
  for (const p of passwords) {
    const list = byNetwork.get(p.social_network) ?? [];
    list.push(p);
    byNetwork.set(p.social_network, list);
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Настройки</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Пароли</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Логины и пароли внешних аккаунтов (соцсети и т.п.). Каждая соцсеть может содержать
          сколько угодно аккаунтов. Пароли скрыты по умолчанию — раскрываются кнопкой-глазом.
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

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">Сохранённые аккаунты</div>
            {passwords.length === 0 ? (
              <div className="text-sm text-muted py-4">Список пуст — добавьте аккаунт формой ниже.</div>
            ) : (
              [...byNetwork.entries()].map(([network, rows]) => (
                <div key={network} className="flex flex-col gap-2">
                  <div className="text-[11px] uppercase tracking-wide text-mutedLight">{network}</div>
                  <div className="flex flex-col">
                    {rows.map((p) => {
                      const isRevealed = revealed.has(p.id);
                      return (
                        <div
                          key={p.id}
                          className="grid grid-cols-[1fr_1fr_auto_auto] gap-3 items-center py-2 border-b border-borderSoft text-[13px]"
                        >
                          <div className="font-semibold truncate">
                            {p.login}
                            {p.label ? <span className="text-muted font-normal"> · {p.label}</span> : null}
                          </div>
                          <div className="num text-muted truncate">
                            {isRevealed ? p.password : "•".repeat(Math.min(p.password.length, 12))}
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleReveal(p.id)}
                            title={isRevealed ? "Скрыть пароль" : "Показать пароль"}
                            className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-ink border border-border"
                          >
                            {isRevealed ? <IconEyeOff /> : <IconEye />}
                          </button>
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={() => handleDelete(p.id)}
                              className="text-[#A34B36] font-semibold text-left"
                            >
                              Удалить
                            </button>
                          ) : (
                            <span />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {canEdit && (
            <form
              onSubmit={handleAdd}
              className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
            >
              <div className="text-[15px] font-bold">Добавить аккаунт</div>
              <div className="grid grid-cols-[160px_1fr_1fr_1fr] gap-3">
                <input
                  type="text"
                  required
                  placeholder="Соцсеть, например Instagram"
                  value={newNetwork}
                  onChange={(e) => setNewNetwork(e.target.value)}
                  className="border border-border rounded-lg px-3 py-2.5 text-sm"
                />
                <input
                  type="text"
                  required
                  placeholder="Логин / e-mail"
                  value={newLogin}
                  onChange={(e) => setNewLogin(e.target.value)}
                  className="border border-border rounded-lg px-3 py-2.5 text-sm"
                />
                <input
                  type="text"
                  required
                  placeholder="Пароль"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="border border-border rounded-lg px-3 py-2.5 text-sm num"
                />
                <input
                  type="text"
                  placeholder="Заметка (необязательно)"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  className="border border-border rounded-lg px-3 py-2.5 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={adding}
                className="self-start text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
              >
                {adding ? "Добавляем…" : "Добавить аккаунт"}
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
