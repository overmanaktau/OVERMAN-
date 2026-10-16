// Меню бота СММ по ролям.
import { citiesOf, seesSpend, type SmmRole } from "@/lib/smm/config";
import type { ReplyMarkup } from "@/lib/smm/telegram";

export type Feat = "tg" | "ps" | "st" | "cs" | "on" | "sp";
export const BTN: Record<Feat, string> = {
  tg: "🎯 Что в таргете",
  ps: "📊 Аналитика постов",
  st: "🎞 Истории",
  cs: "🛍 Продажи по категориям",
  on: "🛒 Онлайн-продажи",
  sp: "💵 Расход на рекламу",
};
export const REMOVE_KEYBOARD = { remove_keyboard: true };

export function canUse(role: SmmRole, feat: Feat): boolean {
  if (feat === "sp") return seesSpend(role);
  if (feat === "on") return citiesOf(role).includes("aktau");
  return true;
}

export function menuFor(role: SmmRole): ReplyMarkup {
  const feats = (Object.keys(BTN) as Feat[]).filter((f) => canUse(role, f));
  const rows: { text: string }[][] = [];
  for (let i = 0; i < feats.length; i += 2) rows.push(feats.slice(i, i + 2).map((f) => ({ text: BTN[f] })));
  return { keyboard: rows, resize_keyboard: true };
}
