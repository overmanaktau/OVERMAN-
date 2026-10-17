// Сертификаты в отчётах продаж. Сертификаты по кассе не пробиваются (учёт ведётся в боте-помощнике), поэтому деньги за них и оплата
// ими чеков считаются здесь. Правила владельца (08.10.2026):
//  · выручка по чекам остаётся как в МойСклад;
//  · «Всего поступило» = оплаты по чекам − суммы сертификатов, которыми оплачены чеки (вычитаем по способу оплаты самого сертификата)
//    + продажи сертификатов − возвраты сертификатов;
//  · остатка по сертификату нет: если чек меньше номинала, вычитаем меньшее из (сумма чека, номинал), разница «сгорела при использовании»;
//  · использованный сертификат второй раз в поступлениях не учитывается (он вычитается из оплаты чека, а деньги за него поступили при продаже).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { dayWindow } from "@/lib/moysklad";

type CertRow = {
  id: number;
  store: string;
  amount: number;
  pay_cash: number;
  pay_noncash: number;
  status: string;
  sold_at: string;
  expires_at: string;
  used_at: string | null;
  returned_at: string | null;
  use_demand_id: string | null;
  use_demand_sum: number | null;
};

export type CertSummary = {
  soldCount: number;
  soldCash: number;
  soldNoncash: number;
  returnedCount: number;
  returnedCash: number;
  returnedNoncash: number;
  usedCount: number; // использовано в периоде (по дате использования)
  usedAmount: number;
  deductCash: number; // сколько из оплат чеков периода оплачено сертификатами (по способу оплаты сертификата)
  deductNoncash: number;
  burned: number; // сгорело при использовании (чек меньше номинала)
  unusedCount: number; // на данный момент: не использованы и срок не вышел
  unusedAmount: number;
  expiredCount: number; // неиспользованные с истёкшим сроком
  expiredAmount: number;
  hasActivity: boolean;
};

const SELECT = "id, store, amount, pay_cash, pay_noncash, status, sold_at, expires_at, used_at, returned_at, use_demand_id, use_demand_sum";

function almatyRange(from: string, to: string): { fromIso: string; toIso: string } {
  const end = new Date(`${to}T00:00:00+05:00`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { fromIso: new Date(`${from}T00:00:00+05:00`).toISOString(), toIso: end.toISOString() };
}

export async function certificateSummary(cityCodes: string[], from: string, to: string): Promise<CertSummary> {
  const { fromIso, toIso } = almatyRange(from, to);
  const ms = { from: dayWindow(from).from, to: dayWindow(to).to };
  const [sold, returned, usedByDate, usedByCheck, open] = await Promise.all([
    supabaseAdmin.from("certificates").select(SELECT).in("store", cityCodes).gte("sold_at", fromIso).lt("sold_at", toIso),
    supabaseAdmin.from("certificates").select(SELECT).in("store", cityCodes).eq("status", "returned").gte("returned_at", fromIso).lt("returned_at", toIso),
    supabaseAdmin.from("certificates").select(SELECT).in("store", cityCodes).eq("status", "used").gte("used_at", fromIso).lt("used_at", toIso),
    // чеки периода (тем же окном, что и оплаты по чекам в отчёте): время чека хранится как в МойСклад
    supabaseAdmin.from("certificates").select(SELECT).in("store", cityCodes).eq("status", "used").gte("use_demand_moment", ms.from).lt("use_demand_moment", ms.to),
    supabaseAdmin.from("certificates").select(SELECT).in("store", cityCodes).eq("status", "active"),
  ]);
  for (const r of [sold, returned, usedByDate, usedByCheck, open]) if (r.error) throw r.error;

  const rows = (r: { data: unknown }) => (r.data ?? []) as CertRow[];
  const sum = (list: CertRow[], f: (c: CertRow) => number) => list.reduce((a, c) => a + f(c), 0);

  // вычет из оплат чеков: по каждому чеку — меньшее из (сумма чека, суммарный номинал привязанных сертификатов)
  const byCheck = new Map<string, CertRow[]>();
  for (const c of rows(usedByCheck)) {
    const key = c.use_demand_id ?? `cert-${c.id}`;
    byCheck.set(key, [...(byCheck.get(key) ?? []), c]);
  }
  let deductCash = 0;
  let deductNoncash = 0;
  let burned = 0;
  for (const list of byCheck.values()) {
    const nominal = sum(list, (c) => Number(c.amount));
    const checkSum = list[0].use_demand_sum != null ? Number(list[0].use_demand_sum) : nominal;
    const deducted = Math.min(checkSum, nominal);
    burned += nominal - deducted;
    const k = nominal > 0 ? deducted / nominal : 0;
    for (const c of list) {
      deductCash += Number(c.pay_cash) * k;
      deductNoncash += Number(c.pay_noncash) * k;
    }
  }

  const now = Date.now();
  const isExpired = (c: CertRow) => new Date(c.expires_at).getTime() <= now;
  const unused = rows(open).filter((c) => !isExpired(c));
  const expired = rows(open).filter(isExpired);
  const s: CertSummary = {
    soldCount: rows(sold).length,
    soldCash: sum(rows(sold), (c) => Number(c.pay_cash)),
    soldNoncash: sum(rows(sold), (c) => Number(c.pay_noncash)),
    returnedCount: rows(returned).length,
    returnedCash: sum(rows(returned), (c) => Number(c.pay_cash)),
    returnedNoncash: sum(rows(returned), (c) => Number(c.pay_noncash)),
    usedCount: rows(usedByDate).length,
    usedAmount: sum(rows(usedByDate), (c) => Number(c.amount)),
    deductCash,
    deductNoncash,
    burned,
    unusedCount: unused.length,
    unusedAmount: sum(unused, (c) => Number(c.amount)),
    expiredCount: expired.length,
    expiredAmount: sum(expired, (c) => Number(c.amount)),
    hasActivity: false,
  };
  s.hasActivity = s.soldCount > 0 || s.returnedCount > 0 || deductCash + deductNoncash > 0 || s.usedCount > 0;
  return s;
}
