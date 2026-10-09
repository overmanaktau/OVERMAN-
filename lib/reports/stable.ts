// Контрольный пересчёт: отчёт считается два раза независимо; если результаты совпали — отправляем.
// Не совпали — считаем в третий раз: если третий совпал с одним из первых двух, берём его (случайный сбой
// запроса к МойСклад отсеивается); если все три разные или нет двух одинаковых — данным верить нельзя,
// отчёт не отправляется.
export type StableResult<T> = { ok: true; value: T; passes: number } | { ok: false; reason: string };

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function stable<T>(build: () => Promise<T>, key: (v: T) => string): Promise<StableResult<T>> {
  const attempt = async (): Promise<Attempt<T>> => {
    try {
      return { ok: true, value: await build() };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const results: Attempt<T>[] = await Promise.all([attempt(), attempt()]);
  const values = (list: Attempt<T>[]): T[] => list.flatMap((r) => (r.ok ? [r.value] : []));
  let vals = values(results);
  if (vals.length === 2 && key(vals[0]) === key(vals[1])) return { ok: true, value: vals[0], passes: 2 };

  // третий подсчёт
  const third = await attempt();
  if (third.ok) {
    const match = vals.find((v) => key(v) === key(third.value));
    if (match !== undefined) return { ok: true, value: match, passes: 3 };
    vals = [...vals, third.value];
  } else if (vals.length === 0) {
    throw third.error; // МойСклад вообще не отвечает — это ошибка, а не «нестабильные данные»
  }
  return { ok: false, reason: vals.length >= 2 ? "три подсчёта дали разные результаты" : "не удалось получить два совпадающих подсчёта" };
}
