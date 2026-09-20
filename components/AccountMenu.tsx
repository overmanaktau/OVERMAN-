"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import { useTheme } from "@/components/ThemeProvider";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";

function IconSystem() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconSun() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function IconMoon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

const THEME_OPTIONS = [
  { value: "system" as const, label: "Системная", icon: IconSystem },
  { value: "light" as const, label: "Светлая", icon: IconSun },
  { value: "dark" as const, label: "Тёмная", icon: IconMoon },
];

function initials(name: string | null, email: string | null): string {
  const source = (name ?? "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }
  return (email ?? "?").slice(0, 2).toUpperCase();
}

export default function AccountMenu() {
  const router = useRouter();
  const { email, fullName } = useAuth();
  const { theme, setTheme } = useTheme();
  const { requestNavigation } = useUnsavedChanges();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function doLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  function handleLogout() {
    setOpen(false);
    requestNavigation(doLogout);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 bg-surface border border-border rounded-full pl-1.5 pr-3 py-1.5 shadow-md max-w-[240px]"
      >
        <div className="w-7 h-7 rounded-full bg-accent text-paper text-[11px] font-bold flex items-center justify-center flex-none">
          {initials(fullName, email)}
        </div>
        <div className="flex flex-col items-start min-w-0 leading-tight">
          <span className="text-[12px] font-semibold text-ink truncate max-w-[160px]">{fullName || "Без имени"}</span>
          <span className="text-[10.5px] text-mutedLight truncate max-w-[160px]">{email}</span>
        </div>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[220px] rounded-lg border border-border bg-surface shadow-lg p-1.5 flex flex-col gap-1">
          <div className="px-2 py-1.5">
            <div className="text-[10.5px] uppercase tracking-wide text-mutedLight mb-1.5">Тема</div>
            <div className="flex items-center gap-0.5 bg-paper rounded-md p-1">
              {THEME_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = theme === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTheme(opt.value)}
                    title={opt.label}
                    className={`flex-1 h-8 rounded-md flex items-center justify-center ${
                      active ? "bg-accent text-paper" : "text-muted hover:text-ink"
                    }`}
                  >
                    <Icon />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="h-px bg-border mx-1" />
          <div className="px-2 py-1.5">
            <div className="text-[10.5px] uppercase tracking-wide text-mutedLight mb-1.5">Версия сайта</div>
            <div className="flex items-center gap-0.5 bg-paper rounded-md p-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Версия для ПК"
                className="flex-1 h-8 rounded-md text-[12.5px] font-semibold bg-accent text-paper"
              >
                Для ПК
              </button>
              <button
                type="button"
                disabled
                title="Скоро"
                className="flex-1 h-8 rounded-md text-[12.5px] text-mutedLight cursor-not-allowed"
              >
                Мобильная (скоро)
              </button>
            </div>
          </div>
          <div className="h-px bg-border mx-1" />
          <button
            type="button"
            onClick={handleLogout}
            className="text-[13px] text-left font-semibold text-[#A34B36] px-2 py-2 rounded-md hover:bg-paper"
          >
            Выход
          </button>
        </div>
      )}
    </div>
  );
}
