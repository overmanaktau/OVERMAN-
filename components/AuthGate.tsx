"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type AuthContextValue = {
  email: string | null;
  role: "admin" | "editor" | null;
};

const AuthContext = createContext<AuthContextValue>({ email: null, role: null });

export function useAuth() {
  return useContext(AuthContext);
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [value, setValue] = useState<AuthContextValue>({ email: null, role: null });

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

        const { data: roleRow, error: roleError } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (roleError) throw roleError;

        if (!active) return;
        setValue({
          email: session.user.email ?? null,
          role: (roleRow?.role as "admin" | "editor") ?? "editor",
        });
        setStatus("ready");
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
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
  }, [router]);

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
        <div className="bg-white border border-border rounded-card p-8 max-w-sm text-center flex flex-col gap-4">
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
