// Счётчики посетителей GSM Counters (http://www.gsmcounters.com, публичный
// Web API, описание — на главной странице сервиса). Ключ организации лежит в
// переменной окружения GSMCOUNTERS_ORG_KEY, на клиент не попадает.
const BASE_URL = "http://www.gsmcounters.com/api";

// Какой счётчик к какой точке относится — по названию объекта в портале
// счётчиков (ObjectCode): так не нужно вшивать ключи устройств в код.
const STORE_BY_OBJECT_CODE: Record<string, string> = {
  Overman: "point_1", // Актау
  "Overman Aktobe": "point_3", // Актобе
};

// Считаются только часы рабочего времени 10:00–23:59 (часы с 10 по 23) —
// одинаково для всех точек, сейчас и в будущем (решение владельца). Всё, что
// счётчик насчитал до 10:00, в трафик не идёт.
const WORK_FROM_HOUR = 10;

// Сколько процентов «вошло» вычитается по точке. Актау: счётчик у входа
// считает и тех, кто зашёл не за покупкой (сотрудники и т.п.), — по решению
// владельца в трафик идёт «вошло» минус 5%. Актобе — по факту.
const DEDUCT_PERCENT: Record<string, number> = { point_1: 5, point_3: 0 };

function orgKey(): string {
  const key = process.env.GSMCOUNTERS_ORG_KEY;
  if (!key) throw new Error("GSMCOUNTERS_ORG_KEY не задан.");
  return key;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`GSM Counters ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

type DeviceInfo = { Key: string; ObjectCode: string; DtDataTo: string };
type DeviceData = { Key: string; Items: { DTime: string; Income: number; Outcome: number }[] };

export type DailyTraffic = {
  store: string;
  date: string; // YYYY-MM-DD
  income: number; // «вошло» за сутки по счётчику (сумма почасовых значений)
  fact: number; // сколько идёт в трафик факт: income минус процент точки
  complete: boolean; // счётчик уже передал данные до конца этих суток
};

// Трафик точек за один день по часам с `fromHour` (по умолчанию 10:00) до `untilHour`:00 (не включая) — для дневного отчёта
// «сегодня до 17:00». Возвращает карту точка → { income, fact }, fact — с вычетом процента точки.
export async function fetchTrafficUntilHour(
  dateYmd: string,
  untilHour: number,
  fromHour = WORK_FROM_HOUR
): Promise<Map<string, { income: number; fact: number }>> {
  const key = orgKey();
  const [devices, data] = await Promise.all([
    getJson<DeviceInfo[]>(`/device/list/${key}`),
    getJson<DeviceData[]>(`/data/${key}/3/false`),
  ]);
  const deviceByKey = new Map(devices.map((d) => [d.Key, d]));
  const incomeByStore = new Map<string, number>();
  for (const device of data) {
    const info = deviceByKey.get(device.Key);
    const store = info ? STORE_BY_OBJECT_CODE[info.ObjectCode] : undefined;
    if (!info || !store) continue;
    for (const item of device.Items) {
      if (item.DTime.slice(0, 10) !== dateYmd) continue;
      const hour = Number(item.DTime.slice(11, 13));
      if (hour < fromHour || hour >= untilHour) continue;
      incomeByStore.set(store, (incomeByStore.get(store) ?? 0) + (Number(item.Income) || 0));
    }
  }
  const result = new Map<string, { income: number; fact: number }>();
  for (const [store, income] of incomeByStore) {
    const percent = DEDUCT_PERCENT[store] ?? 0;
    result.set(store, { income, fact: Math.round(income * (1 - percent / 100) * 100) / 100 });
  }
  return result;
}

// «Вошло» (Income) по суткам для каждой точки за последние `days` дней
// (максимум 20 — ограничение метода сервиса). Текущие незавершённые сутки в
// ответ не включаются. Суммируются часы с 10:00 до 23:59 (WORK_FROM_HOUR);
// собственный фильтр рабочего времени сервиса не используется — у него своё
// расписание по каждому счётчику.
export async function fetchDailyTraffic(days: number, todayYmd: string, fromYmd?: string): Promise<DailyTraffic[]> {
  const key = orgKey();
  const [devices, data] = await Promise.all([
    getJson<DeviceInfo[]>(`/device/list/${key}`),
    getJson<DeviceData[]>(`/data/${key}/${Math.min(Math.max(days, 1), 20)}/false`),
  ]);
  const deviceByKey = new Map(devices.map((d) => [d.Key, d]));
  const result: DailyTraffic[] = [];
  for (const device of data) {
    const info = deviceByKey.get(device.Key);
    const store = info ? STORE_BY_OBJECT_CODE[info.ObjectCode] : undefined;
    if (!info || !store) continue;
    const byDate = new Map<string, number>();
    for (const item of device.Items) {
      if (Number(item.DTime.slice(11, 13)) < WORK_FROM_HOUR) continue;
      const date = item.DTime.slice(0, 10);
      byDate.set(date, (byDate.get(date) ?? 0) + (Number(item.Income) || 0));
    }
    for (const [date, income] of byDate) {
      if (date >= todayYmd) continue; // сегодня ещё идёт
      if (fromYmd && date < fromYmd) continue; // более ранние дни не трогаем
      const percent = DEDUCT_PERCENT[store] ?? 0;
      const fact = Math.round(income * (1 - percent / 100) * 100) / 100;
      // Данные суток полные, если последняя запись счётчика не раньше 23:00
      // этих суток (счётчик передаёт почасовые значения).
      const complete = info.DtDataTo >= `${date}T23:00:00`;
      result.push({ store, date, income, fact, complete });
    }
  }
  return result.sort((a, b) => (a.date === b.date ? a.store.localeCompare(b.store) : a.date.localeCompare(b.date)));
}
