"use client";

import { supabase } from "@/lib/supabaseClient";

// Общие мелочи экрана кассы: запросы к API с входом пользователя, форматы чисел и дат, иконки.

export async function kassaApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${session?.access_token ?? ""}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !(json as { error?: string }).error) throw new Error(`Ошибка ${res.status}`);
  if (!res.ok) {
    const err = new Error((json as { error?: string }).error) as Error & { data?: unknown };
    err.data = json;
    throw err;
  }
  return json;
}

const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
export const num = (n: number) => nf.format(Math.round(n)).replace(/[  ]/g, " ");
export const tg = (n: number) => `${num(n)} ₸`;

export function dateRu(iso: string, withYear = false): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(iso));
}
export function timeRu(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
export function dayMonth(ymd: string): string {
  return `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
}

export function ago(iso: string | null): string {
  if (!iso) return "покупок не было";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date(iso));
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  if (diff <= 0) return "сегодня";
  if (diff === 1) return "вчера";
  if (diff < 31) return `${diff} дн. назад`;
  const months = Math.floor(diff / 30);
  return months < 12 ? `${months} мес. назад` : `${Math.floor(months / 12)} г. назад`;
}

export function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  const n = d.length === 11 && (d.startsWith("7") || d.startsWith("8")) ? d.slice(1) : d.length === 10 ? d : null;
  return n ? `+7 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 8)} ${n.slice(8, 10)}` : raw || "—";
}

// Цвет аватара — по имени, чтобы у клиента он всегда был один и тот же.
const AVATARS = [
  "from-emerald-500 to-teal-600",
  "from-sky-500 to-indigo-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-violet-500 to-purple-600",
  "from-lime-500 to-green-600",
];
export function avatarClass(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
export function CloseIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
export function LinkIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
export function CheckBig({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}
export function CrossBig({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" className={className}>
      <path d="M5 5l14 14M19 5 5 19" />
    </svg>
  );
}
export function TicketIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 9a2 2 0 0 0 0 6v2a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-2a2 2 0 0 1 0-6V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" />
      <path d="M14 6v12" strokeDasharray="2 2.4" />
    </svg>
  );
}
