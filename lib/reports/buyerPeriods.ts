// Периоды отчётов закупщика — как в «Продажах» у администратора: вчера, эта и прошлая неделя, этот и прошлый месяц, свой период.
// Данные по товарам загружаются ночью (за вчера), поэтому «Сегодня» у закупщика нет, а период, по которому данных ещё нет, в меню не показывается.
import { addDays, daysBetween, mondayOf, monthEndOf, monthStartOf } from "@/lib/coach/metrics";

export type BuyerPeriod = "y" | "cw" | "pw" | "m" | "pm" | "c";
export const BUYER_PERIOD_LABEL: Record<BuyerPeriod, string> = { y: "Вчера", cw: "Эта неделя", pw: "Прошлая неделя", m: "Этот месяц", pm: "Прошлый месяц", c: "Свой период" };
export const BUYER_PERIOD_ORDER: BuyerPeriod[] = ["y", "cw", "pw", "m", "pm"];

export type DateRange = { from: string; to: string };

export function resolvePeriod(key: BuyerPeriod, today: string, custom?: DateRange): DateRange {
  const monday = mondayOf(today);
  const prevMonthEnd = addDays(monthStartOf(today), -1);
  switch (key) {
    case "y":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "cw":
      return { from: monday, to: addDays(monday, 6) };
    case "pw":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "m":
      return { from: monthStartOf(today), to: today };
    case "pm":
      return { from: monthStartOf(prevMonthEnd), to: prevMonthEnd };
    default:
      if (!custom) throw new Error("Не задан свой период.");
      return custom;
  }
}

// Предыдущий период для сравнения — как на странице «Склад → Обзор»: «Эта неделя» и «Этот месяц» сравниваются с тем же отрезком прошлой недели / прошлого месяца
// (по сегодняшний день недели / число), «Прошлый месяц» — с месяцем до него, остальные — с таким же по длине периодом прямо перед выбранным.
export function previousPeriod(key: BuyerPeriod, cur: DateRange, today: string): DateRange {
  if (key === "cw") return { from: addDays(cur.from, -7), to: addDays(today, -7) };
  if (key === "m" || key === "pm") {
    const to = addDays(cur.from, -1);
    const from = monthStartOf(to);
    if (key === "pm") return { from, to };
    const lastDay = Number(monthEndOf(from).slice(8, 10));
    return { from, to: `${from.slice(0, 8)}${String(Math.min(Number(cur.to.slice(8, 10)), lastDay)).padStart(2, "0")}` };
  }
  const days = daysBetween(cur.from, cur.to) + 1;
  const to = addDays(cur.from, -1);
  return { from: addDays(to, -(days - 1)), to };
}
