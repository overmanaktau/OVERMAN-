"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

type SocialNetwork = {
  id: number;
  name: string;
  created_at: string;
};

type StoredPassword = {
  id: number;
  social_network_id: number;
  login: string;
  password: string;
  label: string | null;
  store: string | null;
  created_by_name: string | null;
  created_at: string;
};

type HistoryEntry = {
  id: number;
  password_id: number;
  old_login: string;
  old_password: string;
  changed_by_name: string | null;
  changed_at: string;
  stored_passwords: { social_network_id: number; login: string } | null;
};

const ALL_CITIES = "__all__";

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

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PasswordsPage() {
  const { isAdmin, permissions, fullName, email, stores, accessibleStoreCodes } = useAuth();
  const canView = isAdmin || permissions["settings.passwords"].canView;
  const canEdit = isAdmin || permissions["settings.passwords"].canEdit;
  const requesterLabel = fullName || email || "Пользователь";

  const accessibleStores = stores.filter((s) => accessibleStoreCodes.includes(s.code));

  const [networks, setNetworks] = useState<SocialNetwork[]>([]);
  const [passwords, setPasswords] = useState<StoredPassword[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [revealedHistory, setRevealedHistory] = useState<Set<number>>(new Set());
  const [openHistoryFor, setOpenHistoryFor] = useState<Set<number>>(new Set());
  const [cityFilter, setCityFilter] = useState<string>(ALL_CITIES);

  const [newNetworkName, setNewNetworkName] = useState("");
  const [addingNetwork, setAddingNetwork] = useState(false);
  const [editingNetworkId, setEditingNetworkId] = useState<number | null>(null);
  const [editNetworkName, setEditNetworkName] = useState("");
  const [savingNetwork, setSavingNetwork] = useState(false);

  const [newNetworkId, setNewNetworkId] = useState<string>("");
  const [newLogin, setNewLogin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newStore, setNewStore] = useState<string>(ALL_CITIES);
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNetworkId, setEditNetworkId] = useState<string>("");
  const [editLogin, setEditLogin] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editStore, setEditStore] = useState<string>(ALL_CITIES);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [networksRes, passwordsRes, historyRes] = await Promise.all([
        supabase.from("social_networks").select("*").order("name"),
        supabase.from("stored_passwords").select("*").order("created_at"),
        supabase
          .from("stored_password_history")
          .select("*, stored_passwords(social_network_id, login)")
          .order("changed_at", { ascending: false })
          .limit(200),
      ]);
      if (networksRes.error) throw networksRes.error;
      if (passwordsRes.error) throw passwordsRes.error;
      if (historyRes.error) throw historyRes.error;
      setNetworks((networksRes.data ?? []) as SocialNetwork[]);
      setPasswords((passwordsRes.data ?? []) as StoredPassword[]);
      setHistory((historyRes.data ?? []) as HistoryEntry[]);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!newNetworkId && networks.length > 0) setNewNetworkId(String(networks[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networks]);

  function toggleReveal(id: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleRevealHistory(id: number) {
    setRevealedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleHistoryPanel(networkId: number) {
    setOpenHistoryFor((prev) => {
      const next = new Set(prev);
      if (next.has(networkId)) next.delete(networkId);
      else next.add(networkId);
      return next;
    });
  }

  async function handleAddNetwork(e: React.FormEvent) {
    e.preventDefault();
    const name = newNetworkName.trim();
    if (!name) return;
    setAddingNetwork(true);
    setError(null);
    try {
      const { error } = await supabase
        .from("social_networks")
        .insert({ name, created_by_name: requesterLabel });
      if (error) throw error;
      setNewNetworkName("");
      await load();
    } catch (e) {
      setError(/duplicate key|unique/i.test(getErrorMessage(e)) ? "Такая соцсеть уже есть в списке." : getErrorMessage(e));
    } finally {
      setAddingNetwork(false);
    }
  }

  async function handleDeleteNetwork(id: number) {
    if (!window.confirm("Удалить эту соцсеть из списка?")) return;
    setError(null);
    try {
      const { error } = await supabase.from("social_networks").delete().eq("id", id);
      if (error) throw error;
      setEditingNetworkId(null);
      await load();
    } catch (e) {
      setError(
        /foreign key|violates/i.test(getErrorMessage(e))
          ? "Сначала удалите все аккаунты этой соцсети."
          : getErrorMessage(e)
      );
    }
  }

  function startEditNetwork(n: SocialNetwork) {
    setEditingNetworkId(n.id);
    setEditNetworkName(n.name);
  }

  async function saveNetworkName(id: number) {
    const name = editNetworkName.trim();
    if (!name) return;
    setSavingNetwork(true);
    setError(null);
    try {
      const { error } = await supabase.from("social_networks").update({ name }).eq("id", id);
      if (error) throw error;
      setEditingNetworkId(null);
      await load();
    } catch (e) {
      setError(/duplicate key|unique/i.test(getErrorMessage(e)) ? "Такая соцсеть уже есть в списке." : getErrorMessage(e));
    } finally {
      setSavingNetwork(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const login = newLogin.trim();
    const password = newPassword.trim();
    if (!newNetworkId || !login || !password) return;
    setAdding(true);
    setError(null);
    try {
      const { error } = await supabase.from("stored_passwords").insert({
        social_network_id: Number(newNetworkId),
        login,
        password,
        label: newLabel.trim() || null,
        store: newStore === ALL_CITIES ? null : newStore,
        created_by_name: requesterLabel,
      });
      if (error) throw error;
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

  function startEdit(p: StoredPassword) {
    setEditingId(p.id);
    setEditNetworkId(String(p.social_network_id));
    setEditLogin(p.login);
    setEditPassword(p.password);
    setEditLabel(p.label ?? "");
    setEditStore(p.store ?? ALL_CITIES);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(p: StoredPassword) {
    const login = editLogin.trim();
    const password = editPassword.trim();
    if (!login || !password || !editNetworkId) return;
    setSaving(true);
    setError(null);
    try {
      // Log the previous login/password before overwriting, whenever either
      // one actually changes — this is the audit trail the "История" panel
      // reads from.
      if (login !== p.login || password !== p.password) {
        const { error: histError } = await supabase.from("stored_password_history").insert({
          password_id: p.id,
          old_login: p.login,
          old_password: p.password,
          changed_by_name: requesterLabel,
        });
        if (histError) throw histError;
      }
      const { error } = await supabase
        .from("stored_passwords")
        .update({
          social_network_id: Number(editNetworkId),
          login,
          password,
          label: editLabel.trim() || null,
          store: editStore === ALL_CITIES ? null : editStore,
        })
        .eq("id", p.id);
      if (error) throw error;
      setEditingId(null);
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
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

  const networkName = useMemo(() => {
    const m = new Map<number, string>();
    for (const n of networks) m.set(n.id, n.name);
    return m;
  }, [networks]);

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Пароли».</p>
      </div>
    );
  }

  // A city filter narrows to that store's own accounts plus the ones with no
  // store at all (company-wide, e.g. a single shared Instagram) — same
  // "no store = applies everywhere" convention extra_expenses.store uses.
  const filteredPasswords =
    cityFilter === ALL_CITIES ? passwords : passwords.filter((p) => p.store === cityFilter || p.store === null);

  const byNetwork = new Map<number, StoredPassword[]>();
  for (const p of filteredPasswords) {
    const list = byNetwork.get(p.social_network_id) ?? [];
    list.push(p);
    byNetwork.set(p.social_network_id, list);
  }

  const historyByNetwork = new Map<number, HistoryEntry[]>();
  for (const h of history) {
    const netId = h.stored_passwords?.social_network_id;
    if (netId === undefined || netId === null) continue;
    const list = historyByNetwork.get(netId) ?? [];
    list.push(h);
    historyByNetwork.set(netId, list);
  }

  function storeName(code: string | null) {
    if (code === null) return null;
    return stores.find((s) => s.code === code)?.name ?? code;
  }

  const cityOptions = (
    <>
      <option value={ALL_CITIES}>Все города</option>
      {accessibleStores.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name}
        </option>
      ))}
    </>
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <div className="text-xs text-mutedLight">Настройки</div>
            <h1 className="font-serif text-[28px] font-semibold m-0">Пароли</h1>
          </div>
          {accessibleStores.length > 0 && (
            <select
              value={cityFilter}
              onChange={(e) => setCityFilter(e.target.value)}
              className="text-[13px] font-semibold bg-surface border border-border rounded-lg px-3 py-2"
            >
              {cityOptions}
            </select>
          )}
        </div>
        <p className="text-sm text-muted max-w-xl mt-1">
          Логины и пароли внешних аккаунтов, сгруппированные по соцсети. Пароли скрыты по
          умолчанию — раскрываются кнопкой-глазом. Изменения логина/пароля сохраняются в историю.
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
            <div className="text-[15px] font-bold">Соцсети</div>
            {networks.length === 0 ? (
              <div className="text-sm text-muted">Список пуст — добавьте соцсеть ниже.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {networks.map((n) => {
                  const isEditingNetwork = editingNetworkId === n.id;
                  if (isEditingNetwork) {
                    return (
                      <div
                        key={n.id}
                        className="flex items-center gap-1.5 bg-paper border border-accent rounded-full px-2 py-1"
                      >
                        <input
                          type="text"
                          autoFocus
                          value={editNetworkName}
                          onChange={(e) => setEditNetworkName(e.target.value)}
                          className="border border-border rounded-md px-2 py-1 text-[13px] w-32"
                        />
                        <button
                          type="button"
                          disabled={savingNetwork || !editNetworkName.trim()}
                          onClick={() => saveNetworkName(n.id)}
                          className="text-[12px] font-bold text-paper bg-accent rounded-md px-2 py-1 disabled:opacity-50"
                        >
                          Сохранить
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingNetworkId(null)}
                          className="text-[12px] font-semibold text-muted px-1"
                        >
                          Отмена
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteNetwork(n.id)}
                          className="text-[12px] font-semibold text-[#A34B36] px-1"
                        >
                          Удалить
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={n.id}
                      className="flex items-center gap-2 bg-paper border border-border rounded-full px-3.5 py-1.5 text-[13px] font-semibold"
                    >
                      {n.name}
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => startEditNetwork(n)}
                          className="text-mutedLight font-semibold hover:text-ink"
                          title="Изменить соцсеть"
                        >
                          Изменить
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {canEdit && (
              <form onSubmit={handleAddNetwork} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Новая соцсеть, например Telegram"
                  value={newNetworkName}
                  onChange={(e) => setNewNetworkName(e.target.value)}
                  className="border border-border rounded-lg px-3 py-2 text-sm w-64"
                />
                <button
                  type="submit"
                  disabled={addingNetwork || !newNetworkName.trim()}
                  className="text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2 disabled:opacity-50"
                >
                  {addingNetwork ? "Добавляем…" : "Добавить соцсеть"}
                </button>
              </form>
            )}
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">Сохранённые аккаунты</div>
            {filteredPasswords.length === 0 ? (
              <div className="text-sm text-muted py-4">
                {passwords.length === 0 ? "Список пуст — добавьте аккаунт формой ниже." : "Нет аккаунтов для этого города."}
              </div>
            ) : (
              [...byNetwork.entries()].map(([netId, rows]) => {
                const netHistory = historyByNetwork.get(netId) ?? [];
                const historyOpen = openHistoryFor.has(netId);
                return (
                  <div key={netId} className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <div className="text-[11px] uppercase tracking-wide text-mutedLight">
                        {networkName.get(netId) ?? "—"}
                      </div>
                      {netHistory.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleHistoryPanel(netId)}
                          className="text-[11px] font-semibold text-muted underline"
                        >
                          {historyOpen ? "Скрыть историю" : `История (${netHistory.length})`}
                        </button>
                      )}
                    </div>

                    {historyOpen && (
                      <div className="bg-paper border border-borderSoft rounded-lg px-3.5 py-2.5 flex flex-col gap-1.5 mb-1">
                        {netHistory.map((h) => {
                          const isRevealed = revealedHistory.has(h.id);
                          return (
                            <div key={h.id} className="text-[12px] text-muted flex items-center gap-2 flex-wrap">
                              <span className="text-mutedLight">{formatDateTime(h.changed_at)}</span>
                              <span>
                                было: <span className="font-semibold text-ink">{h.old_login}</span> /{" "}
                                <span className="num font-semibold text-ink">
                                  {isRevealed ? h.old_password : "•".repeat(Math.min(h.old_password.length, 10))}
                                </span>
                              </span>
                              <button
                                type="button"
                                onClick={() => toggleRevealHistory(h.id)}
                                className="w-5 h-5 rounded flex items-center justify-center text-mutedLight hover:text-ink"
                              >
                                {isRevealed ? <IconEyeOff /> : <IconEye />}
                              </button>
                              {h.changed_by_name && <span className="text-mutedLight">· {h.changed_by_name}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex flex-col">
                      {rows.map((p) => {
                        const isRevealed = revealed.has(p.id);
                        const city = storeName(p.store);
                        const isEditing = editingId === p.id;

                        if (isEditing) {
                          return (
                            <div
                              key={p.id}
                              className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr_auto] gap-2 items-center py-2 border-b border-borderSoft text-[13px] bg-paper rounded-lg px-2"
                            >
                              <select
                                value={editNetworkId}
                                onChange={(e) => setEditNetworkId(e.target.value)}
                                className="border border-border rounded-md px-2 py-1.5 text-sm"
                              >
                                {networks.map((n) => (
                                  <option key={n.id} value={n.id}>
                                    {n.name}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="text"
                                value={editLogin}
                                onChange={(e) => setEditLogin(e.target.value)}
                                className="border border-border rounded-md px-2 py-1.5 text-sm"
                                placeholder="Логин"
                              />
                              <input
                                type="text"
                                value={editPassword}
                                onChange={(e) => setEditPassword(e.target.value)}
                                className="border border-border rounded-md px-2 py-1.5 text-sm num"
                                placeholder="Пароль"
                              />
                              <input
                                type="text"
                                value={editLabel}
                                onChange={(e) => setEditLabel(e.target.value)}
                                className="border border-border rounded-md px-2 py-1.5 text-sm"
                                placeholder="Заметка"
                              />
                              <select
                                value={editStore}
                                onChange={(e) => setEditStore(e.target.value)}
                                className="border border-border rounded-md px-2 py-1.5 text-sm"
                              >
                                {cityOptions}
                              </select>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => saveEdit(p)}
                                  className="text-[12px] font-bold text-paper bg-accent rounded-md px-2.5 py-1.5 disabled:opacity-50"
                                >
                                  Сохранить
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEdit}
                                  className="text-[12px] font-semibold text-muted"
                                >
                                  Отмена
                                </button>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={p.id}
                            className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-3 items-center py-2 border-b border-borderSoft text-[13px]"
                          >
                            <div className="font-semibold truncate">
                              {p.login}
                              {p.label ? <span className="text-muted font-normal"> · {p.label}</span> : null}
                              {city ? <span className="text-mutedLight font-normal"> · {city}</span> : null}
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
                              <>
                                <button
                                  type="button"
                                  onClick={() => startEdit(p)}
                                  className="text-muted font-semibold text-left"
                                >
                                  Изменить
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDelete(p.id)}
                                  className="text-[#A34B36] font-semibold text-left"
                                >
                                  Удалить
                                </button>
                              </>
                            ) : (
                              <>
                                <span />
                                <span />
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {canEdit && (
            <form
              onSubmit={handleAdd}
              className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
            >
              <div className="text-[15px] font-bold">Добавить аккаунт</div>
              {networks.length === 0 ? (
                <div className="text-sm text-muted">Сначала добавьте хотя бы одну соцсеть выше.</div>
              ) : (
                <>
                  <div className="grid grid-cols-[160px_1fr_1fr_1fr_140px] gap-3">
                    <select
                      required
                      value={newNetworkId}
                      onChange={(e) => setNewNetworkId(e.target.value)}
                      className="border border-border rounded-lg px-3 py-2.5 text-sm"
                    >
                      <option value="" disabled>
                        Выберите соцсеть
                      </option>
                      {networks.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </select>
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
                    {accessibleStores.length > 0 && (
                      <select
                        value={newStore}
                        onChange={(e) => setNewStore(e.target.value)}
                        className="border border-border rounded-lg px-3 py-2.5 text-sm"
                      >
                        {cityOptions}
                      </select>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={adding || !newNetworkId}
                    className="self-start text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
                  >
                    {adding ? "Добавляем…" : "Добавить аккаунт"}
                  </button>
                </>
              )}
            </form>
          )}
        </div>
      )}
    </>
  );
}
