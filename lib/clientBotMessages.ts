// Тексты сообщений клиентам о бонусах (бот @bonus_overman_bot). Только по-русски. Правила: бонус начисляется с покупки и становится доступным через 14 дней,
// хранится 4 месяца; клиент получает сообщение после каждой покупки, в день активации, за 14 дней до сгорания и в день сгорания.
const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");

export type PurchaseInfo = { earned: number; activatesOn: string; spent?: number; available: number; pending: number };

// После покупки: сколько начислено и когда станет доступно; если клиент потратил бонусы — сколько списано.
export function purchaseMessage(p: PurchaseInfo): string {
  const lines = ["🛍 <b>Спасибо за покупку в Overman!</b>", ""];
  if (p.spent && p.spent > 0) lines.push(`Списано бонусов: <b>${fmt(p.spent)}</b>`);
  lines.push(`Начислено бонусов: <b>${fmt(p.earned)}</b> — станут доступны ${p.activatesOn}`, "", `Доступно сейчас: <b>${fmt(p.available)}</b>`, `Ожидает активации: <b>${fmt(p.pending)}</b>`);
  return lines.join("\n");
}

// В день, когда бонусы за покупку стали доступными.
export function activatedMessage(amount: number, available: number): string {
  return `✅ <b>Бонусы активированы</b>\n\nСтали доступны: <b>${fmt(amount)}</b>\nДоступно сейчас: <b>${fmt(available)}</b>`;
}

// За 14 дней до сгорания.
export function expiringSoonMessage(amount: number, burnsOn: string): string {
  return `⏳ <b>Скоро сгорят бонусы</b>\n\n<b>${fmt(amount)}</b> бонусов сгорят ${burnsOn} (бонусы хранятся 4 месяца).\nУспейте потратить их в Overman.`;
}

// В день сгорания.
export function expiredMessage(amount: number, available: number): string {
  return `🔥 <b>Бонусы сгорели</b>\n\nСгорело: <b>${fmt(amount)}</b> (срок хранения — 4 месяца)\nДоступно сейчас: <b>${fmt(available)}</b>`;
}
