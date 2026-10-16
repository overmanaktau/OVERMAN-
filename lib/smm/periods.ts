// Периоды для кнопок и ввода вручную. Даты — календарные по Алматы (YYYY-MM-DD).
import { addDaysYmd } from "@/lib/dayPlan";

export type Period = { from: string; to: string };

export const ruDate = (ymd: string) => ymd.split("-").reverse().join(".");
export function periodLabel(p: Period): string {
  return p.from === p.to ? ruDate(p.from) : `${ruDate(p.from)} – ${ruDate(p.to)}`;
}

export const PERIOD_BUTTONS: { code: string; text: string }[] = [
  { code: "t", text: "Сегодня" },
  { code: "y", text: "Вчера" },
  { code: "7", text: "7 дней" },
  { code: "30", text: "30 дней" },
  { code: "m", text: "Этот месяц" },
  { code: "pm", text: "Прошлый месяц" },
];

const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;

// Код кнопки → период. «c<с>_<по>» — свой период (даты вида 20261001).
export function periodFromCode(code: string, today: string): Period | null {
  switch (code) {
    case "t":
      return { from: today, to: today };
    case "y": {
      const y = addDaysYmd(today, -1);
      return { from: y, to: y };
    }
    case "7":
      return { from: addDaysYmd(today, -6), to: today };
    case "30":
      return { from: addDaysYmd(today, -29), to: today };
    case "m":
      return { from: monthStart(today), to: today };
    case "pm": {
      const to = addDaysYmd(monthStart(today), -1);
      return { from: monthStart(to), to };
    }
  }
  const m = code.match(/^c(\d{8})_(\d{8})$/);
  if (!m) return null;
  const f = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  const t = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
  return f <= t ? { from: f, to: t } : null;
}

export function codeFromPeriod(p: Period): string {
  return `c${p.from.replace(/-/g, "")}_${p.to.replace(/-/g, "")}`;
}

// Ввод вручную: «01.10-15.10», «01.10.2026 - 15.10.2026» или одна дата «15.10» (год — текущий).
export function parseCustomPeriod(text: string, today: string): Period | null {
  const year = Number(today.slice(0, 4));
  const parts = text.replace(/[–—]/g, "-").split("-").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const one = (s: string): string | null => {
    const m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/);
    if (!m) return null;
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : year;
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const back = new Date(`${ymd}T00:00:00Z`);
    return Number.isNaN(back.getTime()) || back.getUTCDate() !== d ? null : ymd;
  };
  const a = one(parts[0]);
  const b = parts.length === 2 ? one(parts[1]) : a;
  if (!a || !b || a > b) return null;
  return { from: a, to: b };
}

export const MAX_DAYS = 120;
export function daysIn(p: Period): number {
  return Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86400000) + 1;
}

// Границы периода для Meta (время Meta — UTC): полночь по Алматы (UTC+5) начала периода и следующих суток после конца.
export function periodUtc(p: Period): { fromIso: string; toIso: string; fromSec: number; toSec: number } {
  const from = new Date(`${p.from}T00:00:00+05:00`);
  const to = new Date(`${addDaysYmd(p.to, 1)}T00:00:00+05:00`);
  return { fromIso: from.toISOString(), toIso: to.toISOString(), fromSec: Math.floor(from.getTime() / 1000), toSec: Math.floor(to.getTime() / 1000) };
}
