// Кнопки под сообщением о задержанных отчётах (только главный владелец): «Перепроверить сейчас»
// и «Отправить отчёты как есть» (с подтверждением).
import { escapeHtml } from "@/lib/telegram";
import type { Transport } from "@/lib/coach/bot";
import { releaseHolds, sendReleasedReports } from "@/lib/verify/holds";

const ORIGIN = "https://www.overman.kz";

export async function handleVerifyCallback(
  data: string,
  t: Transport,
  chatId: number | string,
  ownerName: string,
  dropCurrent: () => Promise<void>,
  clearCurrent: () => Promise<void>
): Promise<void> {
  const [, action, date] = data.split(":"); // vf:r:<date> | vf:f:<date> | vf:fy:<date> | vf:fn:<date>
  const secret = process.env.CRON_SECRET;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !secret) return;

  if (action === "r") {
    await t.send(chatId, "🔄 Перепроверяю… Результат пришлю отдельным сообщением (обычно до минуты).");
    // Сама перепроверка идёт отдельным запросом и сама пишет владельцу итог; здесь ждём недолго,
    // чтобы не упереться во время ответа бота.
    const run = fetch(`${ORIGIN}/api/verify?recheck=1`, { headers: { Authorization: `Bearer ${secret}` } }).catch(() => null);
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 45_000))]);
    return;
  }

  if (action === "f") {
    await dropCurrent();
    await t.send(
      chatId,
      `Отправить задержанные отчёты в группы <b>как есть</b>? Цифры в них могут не сходиться с МойСклад — отвечаете за это вы.`,
      { inline_keyboard: [[{ text: "Да, отправить", callback_data: `vf:fy:${date}` }, { text: "Отмена", callback_data: `vf:fn:${date}` }]] }
    );
    return;
  }

  if (action === "fn") {
    await dropCurrent();
    return;
  }

  if (action === "fy") {
    await clearCurrent();
    await releaseHolds(date, `владелец ${ownerName}: отправлено вручную как есть`);
    const sent = await sendReleasedReports(ORIGIN, secret);
    await t.send(
      chatId,
      sent.length
        ? `📤 Отправлено как есть:\n${sent.map((s) => `• ${escapeHtml(s)}`).join("\n")}`
        : "Задержанных отчётов не было — отправлять нечего."
    );
  }
}
