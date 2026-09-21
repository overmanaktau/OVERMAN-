"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { emptyPermissions, fullPermissions, type Permissions } from "@/lib/permissions";
import { getErrorMessage } from "@/lib/errors";
import { resolveAccessibleStoreCodes, type City, type Store, type StoreAccessGrant } from "@/lib/stores";

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
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [value, setValue] = useState<AuthContextValue>(DEFAULT_VALUE);
  const [reloadTick, setReloadTick] = useState(0);

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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
