"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { emptyPermissions, fullPermissions, type Permissions } from "@/lib/permissions";
import { getErrorMessage } from "@/lib/errors";
import { resolveAccessibleStoreCodes, type City, type Store, type StoreAccessGrant } from "@/lib/stores";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";

const SESSION_LIMIT_MS = 30 * 60 * 1000;
const WARNING_SECONDS = 10;
const RESUME_PATH_KEY = "overman.resumePath";

type AuthContextValue = {
  email: string | null;
  fullName: string | null;
  role: "owner" | "admin" | "editor" | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: Permissions;
  cities: City[];
  stores: Store[];
  accessibleStoreCodes: string[];
  refresh: () => void;
};

const DEFAULT_VALUE: AuthContextValue = {
  email: null,
  fullName: null,
  role: null,
  isAdmin: false,
  isOwner: false,
  permissions: emptyPermissions(),
  cities: [],
  stores: [],
  accessibleStoreCodes: [],
  refresh: () => {},
};

const AuthContext = createContext<AuthContextValue>(DEFAULT_VALUE);

export function useAuth() {
  return useContext(AuthContext);
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isDirty, saveNow } = useUnsavedChanges();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [value, setValue] = useState<AuthContextValue>(DEFAULT_VALUE);
  const [reloadTick, setReloadTick] = useState(0);
  const [lastSignInAt, setLastSignInAt] = useState<string | null>(null);
  const [sessionDeadline, setSessionDeadline] = useState<number | null>(null);
  const [warningSecondsLeft, setWarningSecondsLeft] = useState<number | null>(null);
  const [resumePath, setResumePath] = useState<string | null>(null);
  const resumeCheckedRef = useRef(false);

  useEffect(() => {
    let active = true;

    async function load() {
      setStatus("loading");
      setErrorMsg(null);
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        if (!session) {
          router.replace("/login");
          return;
        }

        const [{ data: roleRow, error: roleError }, { data: cities, error: citiesError }, { data: stores, error: storesError }] =
          await Promise.all([
            supabase.from("user_roles").select("role, role_id, full_name").eq("user_id", session.user.id).maybeSingle(),
            supabase.from("cities").select("id, name").order("name"),
            supabase.from("stores").select("id, city_id, name, code").order("name"),
          ]);
        if (roleError) throw roleError;
        if (citiesError) throw citiesError;
        if (storesError) throw storesError;

        const role = (roleRow?.role as "owner" | "admin" | "editor") ?? "editor";
        const isOwner = role === "owner";
        const isAdmin = role === "admin" || isOwner;

        let permissions = emptyPermissions();
        let accessibleStoreCodes: string[] = [];

        if (isAdmin) {
          permissions = fullPermissions();
          accessibleStoreCodes = (stores ?? []).map((s) => s.code);
        } else if (roleRow?.role_id) {
          const [{ data: permRows, error: permError }, { data: grantRows, error: grantError }] = await Promise.all([
            supabase.from("role_permissions").select("section, can_view, can_edit").eq("role_id", roleRow.role_id),
            supabase.from("role_store_access").select("scope, city_id, store_id").eq("role_id", roleRow.role_id),
          ]);
          if (permError) throw permError;
          if (grantError) throw grantError;

          for (const row of permRows ?? []) {
            if (row.section in permissions) {
              permissions[row.section as keyof Permissions] = {
                canView: row.can_view,
                canEdit: row.can_edit,
              };
            }
          }
          accessibleStoreCodes = resolveAccessibleStoreCodes(
            (stores ?? []) as Store[],
            (grantRows ?? []) as StoreAccessGrant[]
          );
        }

        if (!active) return;
        setValue({
          email: session.user.email ?? null,
          fullName: roleRow?.full_name ?? null,
          role,
          isAdmin,
          isOwner,
          permissions,
          cities: (cities ?? []) as City[],
          stores: (stores ?? []) as Store[],
          accessibleStoreCodes,
          refresh: () => setReloadTick((t) => t + 1),
        });
        setLastSignInAt(session.user.last_sign_in_at ?? null);
        setStatus("ready");
      } catch (e) {
        if (!active) return;
        const message = getErrorMessage(e);
        setErrorMsg(
          /fetch|network/i.test(message)
            ? "Нет связи с сервером. Проверьте интернет-соединение и попробуйте снова."
            : `Не удалось загрузить профиль пользователя: ${message}`
        );
        setStatus("error");
      }
    }

    load();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) router.replace("/login");
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [router, reloadTick]);

  // Presence heartbeat: while this session is open, keep last_seen_at fresh
  // so the employees list can infer who's currently online.
  useEffect(() => {
    if (status !== "ready") return;
    let active = true;

    async function ping() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session || !active) return;
      await supabase
        .from("user_presence")
        .upsert({ user_id: session.user.id, last_seen_at: new Date().toISOString() });
    }

    ping();
    const interval = window.setInterval(ping, 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [status]);

  // Sets the first deadline once we know when this session actually began —
  // every role except the owner, who is never subject to this at all.
  useEffect(() => {
    if (status !== "ready" || value.role === null || value.role === "owner" || !lastSignInAt) return;
    setSessionDeadline((prev) => prev ?? new Date(lastSignInAt).getTime() + SESSION_LIMIT_MS);
  }, [status, value.role, lastSignInAt]);

  // When the deadline arrives, open the warning countdown instead of signing
  // out immediately.
  useEffect(() => {
    if (sessionDeadline === null) return;
    const msLeft = sessionDeadline - Date.now();
    if (msLeft <= 0) {
      setWarningSecondsLeft(WARNING_SECONDS);
      return;
    }
    const timer = window.setTimeout(() => setWarningSecondsLeft(WARNING_SECONDS), msLeft);
    return () => window.clearTimeout(timer);
  }, [sessionDeadline]);

  // Ticks the warning countdown down every second. If it reaches zero
  // without the user clicking "Продолжить", save whatever was already
  // row-confirmed, remember the current page, and sign out.
  useEffect(() => {
    if (warningSecondsLeft === null) return;

    if (warningSecondsLeft <= 0) {
      (async () => {
        try {
          if (isDirty) {
            await saveNow();
            try {
              localStorage.setItem(RESUME_PATH_KEY, pathname);
            } catch {
              // storage unavailable — the resume prompt just won't appear next time
            }
          }
        } catch {
          // don't let a failed save trap the user in an expired session
        }
        await supabase.auth.signOut();
        router.replace("/login");
      })();
      return;
    }

    const timer = window.setTimeout(() => setWarningSecondsLeft((s) => (s ?? 1) - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [warningSecondsLeft, isDirty, saveNow, pathname, router]);

  function handleContinueSession() {
    setWarningSecondsLeft(null);
    setSessionDeadline(Date.now() + SESSION_LIMIT_MS);
  }

  // Right after a successful login, offer to jump back to whatever page the
  // auto sign-out interrupted.
  useEffect(() => {
    if (status !== "ready" || resumeCheckedRef.current) return;
    resumeCheckedRef.current = true;
    try {
      const saved = localStorage.getItem(RESUME_PATH_KEY);
      if (saved) setResumePath(saved);
    } catch {
      // storage unavailable — nothing to resume
    }
  }, [status]);

  function handleResumeYes() {
    const path = resumePath;
    setResumePath(null);
    try {
      localStorage.removeItem(RESUME_PATH_KEY);
    } catch {
      // ignore
    }
    if (path) router.push(path);
  }

  function handleResumeNo() {
    setResumePath(null);
    try {
      localStorage.removeItem(RESUME_PATH_KEY);
    } catch {
      // ignore
    }
  }

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper text-muted text-sm">
        Загрузка…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper px-6">
        <div className="bg-surface border border-border rounded-card p-8 max-w-sm text-center flex flex-col gap-4">
          <div className="text-sm text-[#A34B36]">{errorMsg}</div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-accent text-paper font-bold rounded-lg py-2.5 text-sm"
          >
            Повторить
          </button>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
      {warningSecondsLeft !== null && (
        <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-6">
          <div className="bg-surface border border-border rounded-card p-6 max-w-sm w-full flex flex-col gap-4">
            <div className="text-[15px] font-bold text-ink">Сессия истекает</div>
            <p className="text-sm text-muted">
              Вы будете автоматически выведены из аккаунта через {warningSecondsLeft} сек.
            </p>
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={handleContinueSession}
                className="text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2"
              >
                Продолжить
              </button>
            </div>
          </div>
        </div>
      )}
      {resumePath && (
        <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-6">
          <div className="bg-surface border border-border rounded-card p-6 max-w-sm w-full flex flex-col gap-4">
            <div className="text-[15px] font-bold text-ink">Продолжить с того места?</div>
            <p className="text-sm text-muted">
              В прошлый раз вы вносили изменения, когда произошёл автоматический выход из аккаунта.
              Вернуться туда и продолжить?
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleResumeNo}
                className="text-[13px] font-semibold text-muted px-3.5 py-2 rounded-lg hover:bg-paper"
              >
                Нет
              </button>
              <button
                type="button"
                onClick={handleResumeYes}
                className="text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2"
              >
                Да
              </button>
            </div>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}
