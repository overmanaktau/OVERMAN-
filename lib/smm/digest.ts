// Утренняя рассылка бота СММ (9:10 по Алматы, после вчерашнего отчёта продаж):
//  1) продажи за вчера по категориям (по городам сотрудника), 2) онлайн-продажи (Актау), 3) истории за вчера,
//  4) расход на рекламу за вчера (маркетолог и администратор). Повторный запуск не шлёт то, что уже ушло (журнал smm_messages_sent).
import { todayInAlmaty } from "@/lib/coach/metrics";
import { addDaysYmd } from "@/lib/dayPlan";
import { ONLINE_SELLER, citiesOf, seesSpend } from "@/lib/smm/config";
import { sendCategories, sendStories } from "@/lib/smm/flows";
import { spendText } from "@/lib/smm/reports";
import { syncStories } from "@/lib/smm/stories";
import type { Transport } from "@/lib/smm/telegram";
import { approvedUsers, markSent, wasSent, type SmmUser } from "@/lib/smm/users";
import { getErrorMessage } from "@/lib/errors";

export type MorningResult = { date: string; users: number; sent: number; skipped: number; errors: string[] };

export async function runMorning(t: Transport, opts: { only?: SmmUser[]; force?: boolean } = {}): Promise<MorningResult> {
  const today = todayInAlmaty();
  const date = addDaysYmd(today, -1);
  const p = { from: date, to: date };
  const result: MorningResult = { date, users: 0, sent: 0, skipped: 0, errors: [] };

  try {
    await syncStories(); // свежие цифры по историям, которые ещё живы
  } catch (e) {
    result.errors.push(`истории: ${getErrorMessage(e)}`);
  }

  const users = opts.only ?? (await approvedUsers());
  result.users = users.length;
  for (const u of users) {
    const step = async (kind: string, fn: () => Promise<void>) => {
      if (!opts.force && (await wasSent(u.id, kind, today))) {
        result.skipped++;
        return;
      }
      try {
        await fn();
        if (!opts.force) await markSent(u.id, kind, today);
        result.sent++;
      } catch (e) {
        result.errors.push(`${u.name} · ${kind}: ${getErrorMessage(e)}`);
      }
    };
    for (const city of citiesOf(u.role)) {
      await step(`cat-${city}`, () => sendCategories(t, u.telegram_chat_id, city, p, "all"));
      if (city === ONLINE_SELLER.city) await step("online", () => sendCategories(t, u.telegram_chat_id, city, p, "online"));
      await step(`stories-${city}`, () => sendStories(t, u.telegram_chat_id, city, p));
    }
    if (seesSpend(u.role)) await step("spend", async () => void (await t.send(u.telegram_chat_id, await spendText(p))));
    await new Promise((r) => setTimeout(r, 300));
  }
  return result;
}
