// Полный цикл сверки одного дня: сверка → автоисправление → повторная сверка → удержание или
// выпуск отчётов → сообщение владельцу. Используется ночным заданием (/api/verify), утренней
// перепроверкой и кнопкой «Перепроверить» в боте.
import { escapeHtml } from "@/lib/telegram";
import { pre } from "@/lib/reports/sales";
import type { ReplyMarkup } from "@/lib/coach/bot";
import { autoFix } from "@/lib/verify/autofix";
import { heldDates, releaseHolds, sendReleasedReports, setHold } from "@/lib/verify/holds";
import {
  cityLines,
  problemList,
  reconcileDay,
  reconcileFixedMessage,
  reconcileMessage,
  shortDate,
  type ReconcileResult,
} from "@/lib/verify/reconcile";

export type RunOptions = { origin: string; secret: string; date: string; fix?: boolean; recheck?: boolean; dry?: boolean };
export type RunResult = {
  result: ReconcileResult;
  text: string;
  markup?: ReplyMarkup;
  heldStores: string[];
  fixActions: string[];
  sentReports: string[];
};

const STORE_NAME: Record<string, string> = { point_1: "Актау", point_3: "Актобе", all: "все города" };

// Кнопки под сообщением о задержанных отчётах (обрабатывает бот: lib/verify/botActions.ts).
export function heldButtons(date: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "🔄 Перепроверить сейчас", callback_data: `vf:r:${date}` }],
      [{ text: "📤 Отправить отчёты как есть", callback_data: `vf:f:${date}` }],
    ],
  };
}

export async function runVerification(o: RunOptions): Promise<RunResult> {
  const first = await reconcileDay(o.date);
  let result = first;
  let fixActions: string[] = [];
  if (!first.ok && o.fix !== false && !o.dry) {
    fixActions = await autoFix(o.origin, o.secret, o.date, first.checks.filter((c) => !c.ok));
    result = await reconcileDay(o.date);
  }

  // Отчётов касается всё, кроме снимка остатков (он нужен только оборачиваемости).
  const failed = result.checks.filter((c) => !c.ok && c.kind !== "snapshot");
  const heldStores = [...new Set(failed.map((c) => c.store ?? "all"))];
  const date = shortDate(o.date);

  if (o.dry) {
    const text = result.ok ? reconcileMessage(result) : reconcileFixedMessage(first, result, fixActions);
    return { result, text, heldStores, fixActions, sentReports: [] };
  }

  if (heldStores.length > 0) {
    for (const s of heldStores) {
      const reason = failed.filter((c) => (c.store ?? "all") === s).map((c) => c.title).join("; ");
      await setHold(o.date, s, reason);
    }
    // С городов, где расхождение пропало, удержание снимаем и отправляем то, что ждало.
    await releaseHolds(o.date, "авто: расхождение исправлено", heldStores);
    const sentReports = await sendReleasedReports(o.origin, o.secret);
    const names = heldStores.map((s) => STORE_NAME[s] ?? s).join(", ");
    const title = o.recheck
      ? `⏸ <b>Перепроверка за ${date}: расхождение осталось</b>`
      : `⏸ <b>Сверка за ${date}: расхождение исправить не удалось — отчёты задержаны</b>`;
    const done = fixActions.length ? `\n\n<b>Что сделано:</b>\n${fixActions.map((a) => `• ${escapeHtml(a)}`).join("\n")}` : "";
    const sent = sentReports.length ? `\n\n<b>Ушло в группы:</b>\n${sentReports.map((a) => `• ${escapeHtml(a)}`).join("\n")}` : "";
    const text =
      `${title}\n${pre(cityLines(result))}\n<b>Осталось:</b>\n${problemList(failed)}${done}${sent}\n\n` +
      `Отчёты по городу (${names}) в группы <b>не отправляются</b>, пока это не исправлено. Как только расхождение пропадёт, они уйдут сами (проверка повторится утром и по кнопке).`;
    return { result, text, markup: heldButtons(o.date), heldStores, fixActions, sentReports };
  }

  // Всё сходится (сразу или после исправления): снимаем удержание и отправляем ждавшие отчёты.
  const hadHold = (await heldDates()).includes(o.date);
  await releaseHolds(o.date, "авто: расхождение исправлено");
  const sentReports = await sendReleasedReports(o.origin, o.secret);
  const sentBlock = sentReports.length ? `\n\n<b>Отправлено в группы:</b>\n${sentReports.map((a) => `• ${escapeHtml(a)}`).join("\n")}` : "";

  let text: string;
  if (!first.ok) text = reconcileFixedMessage(first, result, fixActions) + sentBlock;
  else if (hadHold) text = `✅ <b>Перепроверка за ${date}: теперь всё сходится</b>\n${pre(cityLines(result))}${sentBlock}`;
  else text = reconcileMessage(result) + sentBlock;
  return { result, text, heldStores, fixActions, sentReports };
}
