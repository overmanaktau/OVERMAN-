// Расчёт бонусов клиента по партиям (правила владельца):
//  · бонусы, начисленные за покупку, становятся доступными через 14 дней — от КАЖДОЙ покупки отдельно;
//  · бонусы сгорают через 4 месяца со дня начисления;
//  · списания (оплата бонусами, возврат покупки) уменьшают партии, самые старые первыми; списание по
//    возврату сначала уменьшает партию той покупки, которую вернули.
//  · всё по факту: если при возврате нужно списать больше бонусов, чем осталось (клиент уже потратил заработанные на этот товар),
//    разница не теряется — баланс уходит в минус (долг), и следующие начисления сначала гасят его.
// Максимум оплаты бонусами (100% чека) контролирует сама бонусная программа МойСклад.

export const ACTIVATION_DAYS = 14;
export const EXPIRY_MONTHS = 4;

export type BonusTx = {
  id: string;
  moment: string; // ISO
  value: number;
  kind: "earn" | "spend";
  status: string;
  parentType: string;
  parentId: string;
};

export type Lot = {
  id: string;
  parentId: string;
  date: string; // YYYY-MM-DD по Алматы
  earned: number;
  remaining: number;
  state: "waiting" | "active" | "expired";
  activatesOn: string; // дата, с которой бонусы доступны
  expiresOn: string; // дата, с которой бонусы сгорают
};

export type BonusSummary = {
  balance: number; // всё, что есть у клиента (без сгоревших); может быть отрицательным, если по возврату списано больше, чем было
  available: number; // можно списать сейчас
  waiting: number; // ждёт активации
  nextActivation: string | null; // когда откроется ближайшая партия
  expired: number; // срок вышел, ещё не списано
  debt: number; // сколько списано по возвратам сверх остатка партий (долг клиента); balance уже учитывает его
  lots: Lot[];
};

export function almatyDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date(iso));
}

function addDaysYmd(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonthsYmd(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

// returnDemand: id возврата → id чека, который вернули (чтобы списание по возврату попало в нужную партию).
export function computeBonus(txs: BonusTx[], returnDemand: Map<string, string>, today: string): BonusSummary {
  const done = txs.filter((t) => t.status === "COMPLETED" && t.value > 0).sort((a, b) => a.moment.localeCompare(b.moment));
  const lots: Lot[] = done
    .filter((t) => t.kind === "earn")
    .map((t) => {
      const date = almatyDate(t.moment);
      return {
        id: t.id,
        parentId: t.parentId,
        date,
        earned: t.value,
        remaining: t.value,
        state: "active" as Lot["state"],
        activatesOn: addDaysYmd(date, ACTIVATION_DAYS),
        expiresOn: addMonthsYmd(date, EXPIRY_MONTHS),
      };
    });

  let debt = 0;
  for (const t of done.filter((x) => x.kind === "spend")) {
    let left = t.value;
    if (t.parentType === "retailsalesreturn") {
      const demandId = returnDemand.get(t.parentId);
      const own = demandId ? lots.find((l) => l.parentId === demandId && l.remaining > 0) : undefined;
      if (own) {
        const take = Math.min(own.remaining, left);
        own.remaining -= take;
        left -= take;
      }
    }
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(lot.remaining, left);
      lot.remaining -= take;
      left -= take;
    }
    // остаток списания, которому не хватило партий (бонусы уже потрачены, а товар вернули) — это долг, а не потеря
    if (left > 0) debt += left;
  }

  let balance = 0;
  let available = 0;
  let waiting = 0;
  let expired = 0;
  let nextActivation: string | null = null;
  for (const lot of lots) {
    if (lot.remaining <= 0) continue;
    if (today >= lot.expiresOn) {
      lot.state = "expired";
      expired += lot.remaining;
    } else if (today >= lot.activatesOn) {
      lot.state = "active";
      available += lot.remaining;
      balance += lot.remaining;
    } else {
      lot.state = "waiting";
      waiting += lot.remaining;
      balance += lot.remaining;
      if (!nextActivation || lot.activatesOn < nextActivation) nextActivation = lot.activatesOn;
    }
  }
  // долг гасится сначала из доступных бонусов, потом из ждущих; что не покрыто — отрицательный баланс
  let rest = debt;
  const fromAvailable = Math.min(available, rest);
  available -= fromAvailable;
  balance -= fromAvailable;
  rest -= fromAvailable;
  const fromWaiting = Math.min(waiting, rest);
  waiting -= fromWaiting;
  balance -= fromWaiting;
  rest -= fromWaiting;
  if (waiting <= 0) nextActivation = null;
  balance -= rest;
  return { balance, available, waiting, nextActivation, expired, debt, lots };
}
