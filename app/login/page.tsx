"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError("Неверный email или пароль.");
      return;
    }
    router.push("/marketing/statistics");
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
