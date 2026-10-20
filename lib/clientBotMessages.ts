// Тексты сообщений клиентам о бонусах (бот @bonus_overman_bot). Только по-казахски (решение владельца 20.10.2026). Правила: бонус начисляется с покупки и становится доступным через 14 дней,
// хранится 4 месяца; клиент получает сообщение после каждой покупки, в день активации, за 14 дней до сгорания и в день сгорания.
const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");

export type PurchaseInfo = { earned: number; activatesOn: string; spent?: number; available: number; pending: number };

// После покупки: сколько начислено и когда станет доступно; если клиент потратил бонусы — сколько списано.
export function purchaseMessage(p: PurchaseInfo): string {
  const lines = ["🛍 <b>Overman-нан сатып алғаныңыз үшін рахмет!</b>", ""];
  if (p.spent && p.spent > 0) lines.push(`Жұмсалған бонус: <b>${fmt(p.spent)}</b>`);
  if (p.earned > 0) lines.push(`Есептелген бонус: <b>${fmt(p.earned)}</b> — ${p.activatesOn} күні қолжетімді болады`);
  lines.push("", `Қазір қолжетімді: <b>${fmt(p.available)}</b>`, `Белсендіруді күтуде: <b>${fmt(p.pending)}</b>`);
  return lines.join("\n");
}

// В день, когда бонусы за покупку стали доступными.
export function activatedMessage(available: number): string {
  return `✅ <b>Бонустар белсендірілді</b>\n\nҚазір қолжетімді: <b>${fmt(available)}</b>`;
}

// За 14 дней до сгорания.
export function expiringSoonMessage(amount: number, burnsOn: string): string {
  return `⏳ <b>Бонустар жақында жойылады</b>\n\n<b>${fmt(amount)}</b> бонус ${burnsOn} күні жойылады (бонустар 4 ай сақталады).\nОларды Overman-да жұмсап үлгеріңіз.`;
}

// В день сгорания.
export function expiredMessage(amount: number, available: number): string {
  return `🔥 <b>Бонустар жойылды</b>\n\nЖойылды: <b>${fmt(amount)}</b> (сақтау мерзімі — 4 ай)\nҚазір қолжетімді: <b>${fmt(available)}</b>`;
}
