// Дневной план оборота города. План месяца делится на периоды месяца (sales_plan_periods: процент от месяца). Внутри периода план недели —
// это средний план за 7 дней периода (план периода ÷ число дней × 7), а план недели раскладывается по дням по долям дней недели: чем сильнее
// день (пятница, суббота, воскресенье), тем больше его доля. Доли посчитаны по реальным продажам (полные недели) и меняются только здесь,
// через владельца портала — на сайте их не поменять.
// Если период не состоит из целых недель (например 1–15 числа), сумма дневных планов периода может немного отличаться от плана периода —
// так же, как отличается состав дней недели в периоде.
//   Актау  — по 12 неделям (15.10.2026): пн 11, вт 11, ср 11, чт 14, пт 17, сб 18, вс 18.
//   Актобе — предварительно, по 6 неделям (магазин с конца августа): пн 7, вт 14, ср 16, чт 13, пт 15, сб 16, вс 19; пересчитать, когда накопится больше недель.
export const WEEKDAY_SHARE: Record<string, number[]> = {
  point_1: [11, 11, 11, 14, 17, 18, 18],
  point_3: [7, 14, 16, 13, 15, 16, 19],
};
const EQUAL = [1, 1, 1, 1, 1, 1, 1];

// 0 — понедельник … 6 — воскресенье
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// План дня: план недели (план месяца × процент периода ÷ дни периода × 7) × доля дня недели.
// from/to — границы периода (для месяца без периодов — весь месяц, percent = 100).
export function dayPlanOf(store: string, date: string, monthPlan: number, period: { from: string; to: string; percent: number }): number {
  if (monthPlan <= 0 || date < period.from || date > period.to) return 0;
  const shares = WEEKDAY_SHARE[store] ?? EQUAL;
  const shareSum = shares.reduce((a, v) => a + v, 0);
  const periodDays = Math.round((Date.UTC(+period.to.slice(0, 4), +period.to.slice(5, 7) - 1, +period.to.slice(8, 10)) - Date.UTC(+period.from.slice(0, 4), +period.from.slice(5, 7) - 1, +period.from.slice(8, 10))) / 86400000) + 1;
  const weekPlan = (((monthPlan * period.percent) / 100) / periodDays) * 7;
  return weekPlan * (shares[weekdayIndex(date)] / shareSum);
}
