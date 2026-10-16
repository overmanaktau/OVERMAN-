// Общие «блоки» бота СММ: их используют и кнопки меню, и утренняя рассылка в 9:10.
import { CITIES, type CityKey } from "@/lib/smm/config";
import { codeFromPeriod, type Period } from "@/lib/smm/periods";
import { categoryMessage, categorySales, onlineSales, type SalesSource } from "@/lib/smm/sales";
import { storiesMessages } from "@/lib/smm/stories";
import { splitText, type Transport } from "@/lib/smm/telegram";

export const cityCode = (c: CityKey) => (c === "aktau" ? "a" : "b");
export const cityFromCode = (code: string): CityKey | null => (code === "a" ? "aktau" : code === "b" ? "aktobe" : null);

// Категории продаж города (или онлайн-продаж) + кнопки «Посмотреть все категории» и «Посмотреть товары».
export async function sendCategories(t: Transport, chat: number, city: CityKey, p: Period, kind: SalesSource, all = false): Promise<void> {
  const report = kind === "online" ? (await onlineSales(p)).report : await categorySales(city, p);
  const { text, hasRest } = categoryMessage(city, p, report, kind, all);
  const feat = kind === "online" ? "on" : "cs";
  const tail = `${cityCode(city)}|${codeFromPeriod(p)}`;
  const rows: { text: string; callback_data: string }[][] = [];
  if (hasRest && !all) rows.push([{ text: "📂 Посмотреть все категории", callback_data: `ca|${feat}|${tail}` }]);
  if (report.rows.length > 0) rows.push([{ text: "📋 Посмотреть товары", callback_data: `g|${feat}|${tail}` }]);
  await t.send(chat, text, rows.length ? { inline_keyboard: rows } : undefined);
}

export async function sendStories(t: Transport, chat: number, city: CityKey, p: Period, now = new Date()): Promise<void> {
  for (const m of await storiesMessages(city, p, now)) {
    if (m.photo) await t.photo(chat, m.photo, m.caption);
    else await t.send(chat, m.caption);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function sendLong(t: Transport, chat: number, text: string): Promise<void> {
  for (const part of splitText(text)) {
    await t.send(chat, part);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export const cityTitle = (c: CityKey) => CITIES[c].title;
