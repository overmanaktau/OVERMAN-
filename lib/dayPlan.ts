// Дневной план оборота города. План месяца делится на периоды месяца (sales_plan_periods: процент от месяца), а план периода
// раскладывается по дням по долям дней недели: чем сильнее день (пятница, суббота, воскресенье), тем больше его доля плана.
// Доли посчитаны по реальным продажам (полные недели) и меняются только здесь, через владельца портала — на сайте их не поменять.
// Сумма дневных планов периода всегда равна плану периода: доли нормируются на дни самого периода (в том числе на неполные недели по краям).
//   Актау  — по 12 неделям (15.10.2026): пн 11, вт 11, ср 11, чт 14, пт 17, сб 18, вс 18.
//   Актобе — предварительно, по 6 неделям (магазин с конца августа): пн 7, вт 14, ср 16, чт 13, пт 15, сб 16, вс 19; пересчитать, когда накопится больше недель.
export const WEEKDAY_SHARE: Record<string, number[]> = {
  point_1: [11, 11, 11, 14, 17, 18, 18],
  point_3: [7, 14, 16, 13, 15, 16, 19],
};
const EQUAL = [1, 1, 1, 1, 1, 1, 1];

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// 0 — понедельник … 6 — воскресенье
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// План дня: план месяца × процент периода (100 — если периоды месяца не заданы) × доля дня недели среди дней периода.
// from/to — границы периода (для месяца без периодов — весь месяц).
export function dayPlanOf(store: string, date: string, monthPlan: number, period: { from: string; to: string; percent: number }): number {
  if (monthPlan <= 0 || date < period.from || date > period.to) return 0;
  const shares = WEEKDAY_SHARE[store] ?? EQUAL;
  let total = 0;
  for (let d = period.from; d <= period.to; d = addDays(d, 1)) total += shares[weekdayIndex(d)];
  if (total <= 0) return 0;
  return ((monthPlan * period.percent) / 100) * (shares[weekdayIndex(date)] / total);
}
