// Агрегация чеков и возвратов дня по кассам и сотрудникам. Общая для ночной синхронизации
// (app/api/moysklad/sync) и для дневного отчёта «до 16:00» (lib/reports/sales.ts): одни и те же
// правила — возврат вычитается в день возврата, чек аннулируется, когда вернули всё, что в нём было.
import {
  fetchDemandInfo,
  fetchReturnedItemsBefore,
  totalCostKopecks,
  type RetailDemand,
  type RetailSalesReturn,
} from "@/lib/moysklad";
import { REGISTER_STORE, SAYA_PARK_REGISTER_ID, SAYA_PARK_RETIRED_FROM } from "@/lib/registers";

export type RegisterAgg = {
  name: string;
  revenue: number;
  receipts: number;
  items: number;
  cost: number;
  returnedAmount: number;
  returnedReceipts: number;
  returnedItems: number;
};
export type EmployeeAgg = RegisterAgg & { store: string };

export async function aggregateSales(date: string, demands: RetailDemand[], returns: RetailSalesReturn[]) {
  const byRegister = new Map<string, RegisterAgg>();
  // Keyed by `${employeeId}|${store}` — an employee normally sells at one
  // store, but keeping store in the key means a rare cross-store shift
  // shows up as two honest rows instead of getting attributed to whichever
  // store happened to sync last.
  const byEmployee = new Map<string, EmployeeAgg>();
  function emptyAgg(): RegisterAgg {
    return { name: "", revenue: 0, receipts: 0, items: 0, cost: 0, returnedAmount: 0, returnedReceipts: 0, returnedItems: 0 };
  }
  for (const d of demands) {
    const id = d.retailStore?.id;
    const name = d.retailStore?.name;
    if (!id || !name || !REGISTER_STORE[id]) continue; // not a live retail register
    if (id === SAYA_PARK_REGISTER_ID && date >= SAYA_PARK_RETIRED_FROM) continue;
    const agg = byRegister.get(id) ?? { ...emptyAgg(), name };
    agg.revenue += (d.sum ?? 0) / 100;
    agg.receipts += 1;
    agg.items += (d.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
    agg.cost += totalCostKopecks(d.positions?.rows) / 100;
    byRegister.set(id, agg);

    const employeeId = d.owner?.id;
    const employeeName = d.owner?.name;
    if (employeeId && employeeName) {
      const store = REGISTER_STORE[id];
      const key = `${employeeId}|${store}`;
      const eAgg = byEmployee.get(key) ?? { ...emptyAgg(), name: employeeName, store };
      eAgg.revenue += (d.sum ?? 0) / 100;
      eAgg.receipts += 1;
      eAgg.items += (d.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
      eAgg.cost += totalCostKopecks(d.positions?.rows) / 100;
      byEmployee.set(key, eAgg);
    }
  }

  // A return always subtracts from the day it happened on, not the day of
  // the original sale — today's return reduces today's numbers, period. It
  // also voids the receipt itself (receipts_count -1) when the whole original
  // check came back (a single-item check, or a multi-item check returned in
  // full), since there's no completed sale left; a return of only part of a
  // multi-item check just shrinks that receipt, it doesn't void it.
  // Counts are shown as they are, not clamped at zero: a return of a sale
  // made on an earlier day leaves a negative number for the return day.
  // returnedAmount/returnedReceipts/returnedItems are kept alongside so the
  // UI can show both the final (already-netted) figure and, next to it, how
  // much of it was returns.
  let returnedAmount = 0;
  let voidedReceipts = 0;
  for (const r of returns) {
    const id = r.retailStore?.id;
    const name = r.retailStore?.name;
    if (!id || !name || !REGISTER_STORE[id]) continue;
    if (id === SAYA_PARK_REGISTER_ID && date >= SAYA_PARK_RETIRED_FROM) continue;
    const agg = byRegister.get(id) ?? { ...emptyAgg(), name };
    const rSum = (r.sum ?? 0) / 100;
    const rItems = (r.positions?.rows ?? []).reduce((acc, p) => acc + (p.quantity ?? 0), 0);
    agg.revenue -= rSum;
    agg.items -= rItems;
    agg.cost -= totalCostKopecks(r.positions?.rows) / 100;
    agg.returnedAmount += rSum;
    agg.returnedItems += rItems;
    returnedAmount += rSum;

    let voidedThisReturn = false;
    const demandHref = r.demand?.meta?.href;
    if (demandHref) {
      const { items: originalItemCount, moment: demandMoment } = await fetchDemandInfo(demandHref);
      // Чек аннулируется, если вернули всё, что в нём было: чек из одного товара или любой
      // чек, вернувшийся целиком (вернули столько товаров, сколько в нём было). Если чек
      // возвращали по частям — несколькими документами и даже в разные дни, — он аннулируется
      // на том возврате, которым вернули последний товар (считаем всё, что вернули раньше).
      const returnedBefore = await fetchReturnedItemsBefore(demandHref, demandMoment, r);
      if (originalItemCount > 0 && returnedBefore < originalItemCount && returnedBefore + rItems >= originalItemCount) {
        agg.receipts -= 1;
        agg.returnedReceipts += 1;
        voidedReceipts += 1;
        voidedThisReturn = true;
      }
    }
    byRegister.set(id, agg);

    const employeeId = r.owner?.id;
    const employeeName = r.owner?.name;
    if (employeeId && employeeName) {
      const store = REGISTER_STORE[id];
      const key = `${employeeId}|${store}`;
      const eAgg = byEmployee.get(key) ?? { ...emptyAgg(), name: employeeName, store };
      eAgg.revenue -= rSum;
      eAgg.items -= rItems;
      eAgg.cost -= totalCostKopecks(r.positions?.rows) / 100;
      eAgg.returnedAmount += rSum;
      eAgg.returnedItems += rItems;
      if (voidedThisReturn) {
        eAgg.receipts -= 1;
        eAgg.returnedReceipts += 1;
      }
      byEmployee.set(key, eAgg);
    }
  }

  return { byRegister, byEmployee, returnedAmount, voidedReceipts };
}
