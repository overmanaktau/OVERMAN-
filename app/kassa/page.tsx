"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import ClientsTab from "./ClientsTab";
import CertificatesTab from "./CertificatesTab";

type Tab = "clients" | "certs";

// Экран кассы: два раздела — «Клиенты» и «Сертификаты». Кассир видит свой город (по доступам входа);
// админу и владельцу, у которых городов несколько, доступен переключатель города для сертификатов.
export default function KassaPage() {
  const router = useRouter();
  const { isAdmin, permissions, stores, accessibleStoreCodes, fullName, email } = useAuth();
  const allowed = isAdmin || permissions["kassa"].canView;
  const canEdit = isAdmin || permissions["kassa"].canEdit;
  const [tab, setTab] = useState<Tab>("clients");
  const codes = accessibleStoreCodes.length ? accessibleStoreCodes : stores.map((s) => s.code);
  const [store, setStore] = useState<string>("");

  useEffect(() => {
    if (!store && codes.length > 0) setStore(codes[0]);
  }, [codes, store]);

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (!allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper p-6">
        <div className="max-w-md rounded-3xl border border-border bg-surface p-8 text-center text-muted">У вас нет доступа к экрану кассы.</div>
      </div>
    );
  }

  const storeName = (code: string) => stores.find((s) => s.code === code)?.name ?? code;

  return (
    <div className="min-h-screen bg-paper text-ink [background-image:radial-gradient(1100px_520px_at_85%_-8%,color-mix(in_srgb,var(--color-accent)_16%,transparent),transparent),radial-gradient(800px_400px_at_-5%_105%,color-mix(in_srgb,var(--color-accent)_10%,transparent),transparent)] bg-no-repeat">
      <header className="sticky top-0 z-30 border-b border-border bg-[color-mix(in_srgb,var(--color-paper)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex min-h-[72px] max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-3">
          <div className="flex items-baseline gap-3">
            <div className="font-serif text-[26px] font-semibold tracking-wide">OVERMAN</div>
            <div className="hidden text-[13px] font-semibold uppercase tracking-[0.25em] text-muted sm:block">касса</div>
          </div>

          <nav className="flex rounded-2xl bg-borderSoft p-1.5 ring-1 ring-border">
            {([["clients", "Клиенты"], ["certs", "Сертификаты"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`rounded-xl px-7 py-2.5 text-[17px] font-extrabold transition ${tab === k ? "bg-surface text-ink shadow-md" : "text-muted hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3 text-right">
            {codes.length > 1 && tab === "certs" ? (
              <select value={store} onChange={(e) => setStore(e.target.value)} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-bold text-ink">
                {codes.map((c) => (
                  <option key={c} value={c}>{storeName(c)}</option>
                ))}
              </select>
            ) : (
              <div className="hidden rounded-xl bg-borderSoft px-3.5 py-2 text-[13px] font-bold text-ink ring-1 ring-border sm:block">{storeName(codes[0] ?? "")}</div>
            )}
            <button type="button" onClick={logout} className="text-[12.5px] font-semibold text-mutedLight hover:text-ink" title={fullName ?? email ?? ""}>
              Выйти
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-16 pt-8">
        {tab === "clients" && <ClientsTab />}
        {tab === "certs" && (canEdit ? <CertificatesTab store={store || codes[0]} /> : <div className="rounded-3xl border border-border bg-surface p-8 text-center text-muted">Для сертификатов нужен доступ на редактирование.</div>)}
      </main>
    </div>
  );
}
