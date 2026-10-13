import { createHash } from "node:crypto";

// Секрет в адресе веб-хука МойСклад (заголовков МойСклад не добавляет): выводится из CRON_SECRET, отдельной переменной не нужно.
export function webhookToken(): string {
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error("CRON_SECRET не задан.");
  return createHash("sha256").update(`mswebhook:${s}`).digest("hex").slice(0, 40);
}