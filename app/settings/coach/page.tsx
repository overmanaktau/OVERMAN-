"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

type CoachUser = {
  id: number;
  telegram_username: string | null;
  telegram_name: string | null;
  store: string;
  employee_name: string;
  status: "pending" | "approved" | "rejected" | "disabled" | "left";
  requested_at: string;
  left_at: string | null;
  is_admin: boolean;
  is_test: boolean;
  admin_scope: "city" | "all";
  decided_at: string | null;
  decided_by: string | null;
};

type Action = "approve" | "reject" | "disable" | "enable" | "remove";
type Role = "consultant" | "city_admin" | "owner";

const STATUS_LABEL: Record<CoachUser["status"], string> = {
  pending: "Ожидает подтверждения",
  approved: "Подтверждён",
  rejected: "Отклонён",
  disabled: "Отключён",
  left: "Вышел из системы",
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Настройки → Помощник консультантов: заявки стилистов-консультантов, которые написали
// Telegram-боту, и решение владельца по каждому — подтвердить (убедившись, что
// это именно этот сотрудник), отклонить, отключить подтверждённого.
export default function CoachPage() {
  const { isAdmin, permissions, stores } = useAuth();
  const canView = isAdmin || permissions["settings.coach"].canView;
  const canEdit = isAdmin || permissions["settings.coach"].canEdit;

  const [users, setUsers] = useState<CoachUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const storeName = (code: string) => stores.find((s) => s.code === code)?.name ?? code;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: loadError } = await supabase.from("coach_users").select("*").order("requested_at", { ascending: false });
      if (loadError) throw loadError;
      setUsers((data ?? []) as CoachUser[]);
    } catch (e) {
      setError(`Не удалось загрузить: ${getErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  async function changeRole(user: CoachUser, role: Role) {
    if (busyId !== null) return;
    const title = { consultant: "стилистом-консультантом", city_admin: "администратором", owner: "владельцем" }[role];
    if (!window.confirm(`Сделать «${user.employee_name}» ${title}? Ему придёт сообщение с новым меню.`)) {
      await load(); // вернуть выпадающий список к прежнему значению
      return;
    }
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/coach/users/${user.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ action: "role", role }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; notified?: boolean };
      if (!res.ok) throw new Error(json.error ?? `Ошибка ${res.status}`);
      if (json.notified === false) setNotice("Роль изменена, но сообщение в Telegram доставить не удалось.");
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function act(user: CoachUser, action: Action) {
    if (busyId !== null) return;
    if (action === "disable" && !window.confirm(`Отключить «${user.employee_name}»? Бот перестанет с ним работать и присылать сообщения.`)) return;
    if (
      action === "remove" &&
      !window.confirm(`Убрать «${user.employee_name}» из системы? Ему придёт прощальное сообщение, а чтобы вернуться, придётся заново пройти регистрацию.`)
    )
      return;
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`/api/coach/users/${user.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; notified?: boolean };
      if (!res.ok) throw new Error(json.error ?? `Ошибка ${res.status}`);
      if (json.notified === false) setNotice("Статус изменён, но сообщение в Telegram доставить не удалось (проверьте, что бот настроен).");
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Помощник консультантов».</p>
      </div>
    );
  }

  const pending = users.filter((u) => u.status === "pending");
  const approved = users.filter((u) => u.status === "approved");
  const inactive = users.filter((u) => u.status === "rejected" || u.status === "disabled" || u.status === "left");

  function Section({ title, hint, rows }: { title: string; hint?: string; rows: CoachUser[] }) {
    return (
      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3">
        <div>
          <div className="text-[15px] font-bold">
            {title} <span className="text-mutedLight font-normal">· {rows.length}</span>
          </div>
          {hint && <div className="text-[12.5px] text-muted mt-0.5">{hint}</div>}
        </div>
        {rows.length === 0 ? (
          <div className="text-sm text-muted">Пусто.</div>
        ) : (
          <div className="flex flex-col">
            {rows.map((u) => (
              <div key={u.id} className="flex items-center justify-between gap-3 flex-wrap py-2.5 border-t border-borderSoft first:border-t-0">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="text-[13.5px] font-semibold">
                    {u.employee_name} <span className="text-mutedLight font-normal">· {storeName(u.store)}</span>
                  </div>
                  <div className="text-[12px] text-muted">
                    Telegram: {u.telegram_name ?? "—"}
                    {u.telegram_username ? ` (@${u.telegram_username})` : ""} · заявка {formatDateTime(u.requested_at)}
                    {u.status === "left" && u.left_at
                      ? ` · ${STATUS_LABEL[u.status].toLowerCase()} ${formatDateTime(u.left_at)}`
                      : u.decided_at && ` · ${STATUS_LABEL[u.status].toLowerCase()} ${formatDateTime(u.decided_at)}${u.decided_by ? `, ${u.decided_by}` : ""}`}
                  </div>
                </div>
                {canEdit && u.status === "approved" && !u.is_test && (
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    Роль
                    <select
                      value={u.is_admin ? (u.admin_scope === "all" ? "owner" : "city_admin") : "consultant"}
                      disabled={busyId !== null}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                      className="text-[12.5px] font-semibold border border-border rounded-md px-2 py-1.5 bg-surface"
                    >
                      <option value="consultant">Стилист-консультант</option>
                      <option value="city_admin">Администратор</option>
                      <option value="owner">Владелец</option>
                    </select>
                  </label>
                )}
                {canEdit && !u.is_admin && (
                  <div className="flex items-center gap-2">
                    {u.status === "pending" && (
                      <>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => act(u, "approve")}
                          className="text-[12.5px] font-bold text-paper bg-accent rounded-md px-3 py-1.5 disabled:opacity-50"
                        >
                          Подтвердить
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => act(u, "reject")}
                          className="text-[12.5px] font-semibold text-muted border border-border rounded-md px-3 py-1.5 disabled:opacity-50"
                        >
                          Отклонить
                        </button>
                      </>
                    )}
                    {u.status === "approved" && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => act(u, "disable")}
                        className="text-[12.5px] font-semibold text-[#A34B36] border border-[#A34B36] rounded-md px-3 py-1.5 disabled:opacity-50"
                      >
                        Отключить
                      </button>
                    )}
                    {(u.status === "disabled" || u.status === "rejected") && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => act(u, "enable")}
                        className="text-[12.5px] font-semibold text-accent border border-accent rounded-md px-3 py-1.5 disabled:opacity-50"
                      >
                        Включить
                      </button>
                    )}
                    {u.status !== "pending" && u.status !== "left" && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => act(u, "remove")}
                        className="text-[12.5px] font-semibold text-muted border border-border rounded-md px-3 py-1.5 disabled:opacity-50"
                      >
                        Убрать
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Настройки</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Помощник консультантов</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Telegram-бот для стилистов-консультантов: план/факт, что повысить, цель на неделю. Стилист пишет боту, выбирает
          свой город и своё имя — заявка приходит сюда. Подтвердите её, убедившись, что это именно этот сотрудник. Подтверждённого
          можно отключить в любой момент: бот перестанет с ним работать.
        </p>
        {error && <div className="text-sm text-[#A34B36]">{error}</div>}
        {notice && <div className="text-sm text-muted">{notice}</div>}
      </div>

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <Section title="Ожидают подтверждения" hint="Проверьте по имени в Telegram, что заявку подал именно этот сотрудник." rows={pending} />
          <Section title="Подтверждённые" rows={approved} />
          <Section title="Отключённые и отклонённые" rows={inactive} />
        </>
      )}
    </>
  );
}
