// Ставка бонуса продавца от выполнения личного плана (решение владельца 09.11.2026):
// 0–85% → 2%, 86–90% → 2,5%, 91–99% → 3%, 100% и выше → 4%. «Бонус сейчас» (зарплата) = оборот × ставка.
export function bonusRate(fulfillmentPct: number): number {
  if (fulfillmentPct >= 100) return 4;
  if (fulfillmentPct >= 91) return 3;
  if (fulfillmentPct >= 86) return 2.5;
  return 2;
}
