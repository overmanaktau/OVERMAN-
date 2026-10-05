// Автоисправление после сверки: каждое расхождение лечится тем же, чем лечил бы я вручную —
// повторным запуском нужного шага (продажи за день, трафик, снимок остатков). Одна попытка,
// потом сверка повторяется. Шаги дёргаются через собственные адреса сайта с CRON_SECRET.
import type { Check } from "@/lib/verify/reconcile";
import { getErrorMessage } from "@/lib/errors";

export async function autoFix(origin: string, secret: string, date: string, failed: Check[]): Promise<string[]> {
  const actions: string[] = [];
  const call = async (path: string, label: string) => {
    try {
      const res = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(240_000) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      actions.push(res.ok ? `${label}: выполнено` : `${label}: не получилось (${body.error ?? `ошибка ${res.status}`})`);
    } catch (e) {
      actions.push(`${label}: не получилось (${getErrorMessage(e)})`);
    }
  };

  const kinds = new Set(failed.map((c) => c.kind));
  // Продажи, кассы/сотрудники/товары и состояние синхронизации лечатся пересчётом дня
  // (без каталога товаров — он нужен реже и занимает минуты).
  if (kinds.has("sales") || kinds.has("consistency") || kinds.has("sync")) {
    await call(`/api/moysklad/sync?date=${date}&skipCatalog=1`, "Повторный пересчёт продаж за день из МойСклад");
  }
  if (kinds.has("traffic")) await call(`/api/traffic/sync?days=3`, "Повторная загрузка трафика со счётчиков");
  if (kinds.has("snapshot")) await call(`/api/moysklad/sync?snapshot=${date}`, "Снимок остатков за день");
  return actions;
}
