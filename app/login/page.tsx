"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { recordLoginEvent } from "@/lib/loginEvents";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError("Неверный email или пароль.");
      return;
    }
    if (data.session) {
      recordLoginEvent(data.session.user.id, data.session.user.email ?? null);
    }
    // Вход «Касса» (доступ только к экрану кассы) сразу ведёт на него, остальные — в портал как раньше.
    let target = "/marketing/statistics";
    try {
      const userId = data.session?.user.id;
      if (userId) {
        const { data: roleRow } = await supabase.from("user_roles").select("role, role_id").eq("user_id", userId).maybeSingle();
        if (roleRow && roleRow.role !== "admin" && roleRow.role !== "owner" && roleRow.role_id) {
          const { data: perms } = await supabase.from("role_permissions").select("section, can_view").eq("role_id", roleRow.role_id).eq("can_view", true);
          const viewable = (perms ?? []).map((p) => p.section as string);
          if (viewable.includes("kassa") && viewable.every((s) => s === "kassa")) target = "/kassa";
        }
      }
    } catch {
      // не получилось определить роль — идём в обычный раздел
    }
    router.push(target);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper">
      <form
        onSubmit={handleSubmit}
        className="bg-surface border border-border rounded-card p-8 w-full max-w-sm flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1 mb-2">
          <div className="font-serif text-2xl font-semibold">OVERMAN</div>
          <div className="text-sm text-muted">Вход в портал бизнеса</div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-muted" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border border-border bg-surface text-ink rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-muted" htmlFor="password">
            Пароль
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border border-border bg-surface text-ink rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent"
          />
        </div>
        {error && <div className="text-sm text-[#A34B36]">{error}</div>}
        <button
          type="submit"
          disabled={loading}
          className="bg-accent text-paper font-bold rounded-lg py-2.5 text-sm mt-2 disabled:opacity-60"
        >
          {loading ? "Входим…" : "Войти"}
        </button>
      </form>
    </div>
  );
}
