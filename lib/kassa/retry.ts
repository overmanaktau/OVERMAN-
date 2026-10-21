import { getErrorMessage } from "@/lib/errors";

// МойСклад отвечает 429 при слишком частых запросах — ждём и повторяем (до 3 раз), а не записываем сбой.
export async function retry429<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i < 3 && /429/.test(getErrorMessage(e))) {
        await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}
