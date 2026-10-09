"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useSiteVersion } from "@/components/SiteVersion";
import { useStoreSelection } from "@/components/StoreSelection";
import { SalesPlanWindow, type PlanRange } from "@/components/SalesPlanWindow";
import { SalesPlanEntry } from "@/components/SalesPlanEntry";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import PdfButton from "@/components/PdfButton";
import type { PdfDoc } from "@/lib/downloadPdf";

const PERIODS = ["Вчера", "Прошлая неделя", "Эта неделя", "С начала месяца", "Прошлый месяц", "Всё время"];
const DEFAULT_PERIOD = 3; // "С начала месяца"

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function ymd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function stripTime(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

type Range = { start: Date; end: Date };

function getPeriodRange(index: number, today: Date): Range {
  const d = stripTime(today);
  const dow = d.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = addDays(d, mondayOffset);
  const thisSunday = addDays(thisMonday, 6);

  if (index === 0) return { start: addDays(d, -1), end: addDays(d, -1) }; // Вчера
  if (index === 1) return { start: addDays(thisMonday, -7), end: addDays(thisSunday, -7) };
  if (index === 2) return { start: thisMonday, end: thisSunday };
  if (index === 3) return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: d };
  if (index === 4) {
    // Прошлый месяц
    return { start: new Date(d.getFullYear(), d.getMonth() - 1, 1), end: new Date(d.getFullYear(), d.getMonth(), 0) };
  }
  return { start: new Date(2000, 0, 1), end: d }; // "Всё время"
}

function parseYmd(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером базы данных. Проверьте интернет-соединение и попробуйте снова.";
  }
  return `Не удалось выполнить операцию: ${message}`;
}

type RegisterSalesRow = {
  registerId: string;
  name: string;
  store: string | null;
  revenue: number;
  receipts: number;
  items: number;
  cost: number | null;
  returnedAmount: number;
  returnedReceipts: number;
  returnedItems: number;
};

type EmployeeSalesRow = {
  employeeId: string;
  name: string;
  store: string | null;
  revenue: number;
  receipts: number;
  items: number;
  cost: number | null;
  returnedAmount: number;
  returnedReceipts: number;
  returnedItems: number;
  // Трафик города только за дни, когда у сотрудника были продажи (его смены) — знаменатель его конверсии.
  shiftTraffic: number;
};

type EmployeeSortField = "revenue" | "receipts" | "items" | "avgCheck" | "conversion" | "depth";

const EMPLOYEE_SORT_FIELDS: { key: EmployeeSortField; label: string }[] = [
  { key: "revenue", label: "Выручка" },
  { key: "receipts", label: "Чеков" },
  { key: "items", label: "Кол-во товара" },
  { key: "avgCheck", label: "Средний чек" },
  { key: "conversion", label: "Конверсия" },
  { key: "depth", label: "Глубина чека" },
];

// revenue/receipts/items on a row are already net of returns. "Gross" adds
// the returned amounts back — "what it looked like before the return came
// in" — purely for display; nothing that sums across rows elsewhere in the
// app ever uses this, only this page's own toggle.
function SalesField({ label, value, extra }: { label: string; value: React.ReactNode; extra?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted font-normal">{label}</span>
      <span className="num">
        {value}
        {extra && <span className="text-mutedLight font-normal"> {extra}</span>}
      </span>
    </div>
  );
}

function grossOf<T extends { revenue: number; receipts: number; items: number; returnedAmount: number; returnedReceipts: number; returnedItems: number }>(
  r: T
) {
  return {
    revenue: r.revenue + r.returnedAmount,
    receipts: r.receipts + r.returnedReceipts,
    items: r.items + r.returnedItems,
  };
}

export default function SalesPage() {
  const { isAdmin, permissions, stores } = useAuth();
  const { mobileLayout } = useSiteVersion();
  const { selected: selectedStores } = useStoreSelection();
  const canView = isAdmin || permissions["marketing.statistics"].canView;
  // Меняется, когда план продаж внесли заново, — окно «План продаж» перечитывает данные.
  const [planVersion, setPlanVersion] = useState(0);

  const [periodIndex, setPeriodIndex] = useState(DEFAULT_PERIOD);
  const [activeCustom, setActiveCustom] = useState<{ start: string; end: string } | null>(null);
  // Окно «План продаж» следует за выбранным периодом; «С начала месяца» — обычное окно месяца.
  const planRange: PlanRange | null = (() => {
    if (!activeCustom && periodIndex === DEFAULT_PERIOD) return null;
    const r = activeCustom
      ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
      : getPeriodRange(periodIndex, new Date());
    return { from: ymd(r.start), to: ymd(r.end), label: activeCustom ? "Свой период" : PERIODS[periodIndex] };
  })();
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customPickerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerSales, setRegisterSales] = useState<RegisterSalesRow[]>([]);
  const [employeeSales, setEmployeeSales] = useState<EmployeeSalesRow[]>([]);
  // Посетители считаются по городу (traffic_entries.store), не по кассе и
  // не по сотруднику — счётчик на входе не знает, кто именно обслужил
  // зашедшего. Конверсия сотрудника поэтому показывает, какую долю общего
  // трафика его города лично он обратил в чеки — только за дни его смен (нет продаж —
  // нет смены, такой день в его трафик не входит), как и в телеграм-отчётах.
  const [trafficByStore, setTrafficByStore] = useState<Map<string, number>>(new Map());
  const [showGross, setShowGross] = useState(false);
  // Lets you tick a register out of "Продажи по кассам" to isolate what the
  // rest do without it (or tick everything else off to isolate just one) —
  // client-side only, affects nothing but this table's own totals.
  const [hiddenRegisterIds, setHiddenRegisterIds] = useState<Set<string>>(new Set());
  function toggleRegisterHidden(id: string) {
    setHiddenRegisterIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Сортировка "Продажи по сотрудникам" — по умолчанию выручка по убыванию
  // (как и раньше), но пользователь сам выбирает критерий из меню. Только
  // по убыванию — возрастающий порядок не нужен.
  const [employeeSortField, setEmployeeSortField] = useState<EmployeeSortField>("revenue");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // selectedStores starts empty and updates a moment later once the store
  // list finishes loading, firing a second load() call right behind the
  // first — without this guard, whichever of the two happens to resolve
  // last wins, so the correct (non-empty-filter) result could get clobbered
  // by the earlier call's empty-selection result landing after it.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = activeCustom
        ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
        : getPeriodRange(periodIndex, new Date());
      const [
        { data, error: registerError },
        { data: employeeData, error: employeeError },
        { data: trafficData, error: trafficError },
      ] = await Promise.all([
        supabase
          .from("moysklad_sales_daily")
          .select(
            "register_id, revenue, receipts_count, items_count, cost, returned_amount, returned_receipts, returned_items, moysklad_registers(name, store)"
          )
          .gte("sale_date", ymd(r.start))
          .lte("sale_date", ymd(r.end)),
        supabase
          .from("moysklad_employee_sales_daily")
          .select(
            "employee_ms_id, employee_name, store, sale_date, revenue, receipts_count, items_count, cost, returned_amount, returned_receipts, returned_items"
          )
          .gte("sale_date", ymd(r.start))
          .lte("sale_date", ymd(r.end)),
        supabase
          .from("traffic_entries")
          .select("store, entry_date, traffic_fact")
          .in("store", selectedStores)
          .gte("entry_date", ymd(r.start))
          .lte("entry_date", ymd(r.end)),
      ]);
      if (registerError) throw registerError;
      if (employeeError) throw employeeError;
      if (trafficError) throw trafficError;

      const trafficMap = new Map<string, number>();
      const trafficByDay = new Map<string, number>(); // `${город}|${дата}` → трафик за день
      for (const row of (trafficData ?? []) as { store: string; entry_date: string; traffic_fact: number | null }[]) {
        trafficMap.set(row.store, (trafficMap.get(row.store) ?? 0) + (row.traffic_fact ?? 0));
        const dayKey = `${row.store}|${row.entry_date}`;
        trafficByDay.set(dayKey, (trafficByDay.get(dayKey) ?? 0) + (row.traffic_fact ?? 0));
      }
      if (seq === loadSeq.current) setTrafficByStore(trafficMap);

      type Agg = {
        registerId: string;
        name: string;
        store: string | null;
        revenue: number;
        receipts: number;
        items: number;
        costSum: number;
        costMissing: boolean;
        returnedAmount: number;
        returnedReceipts: number;
        returnedItems: number;
      };
      const byRegister = new Map<string, Agg>();
      for (const row of (data ?? []) as unknown as {
        register_id: string;
        revenue: number;
        receipts_count: number;
        items_count: number;
        cost: number | null;
        returned_amount: number | null;
        returned_receipts: number | null;
        returned_items: number | null;
        moysklad_registers: { name: string; store: string | null } | null;
      }[]) {
        const agg = byRegister.get(row.register_id) ?? {
          registerId: row.register_id,
          name: row.moysklad_registers?.name ?? row.register_id,
          store: row.moysklad_registers?.store ?? null,
          revenue: 0,
          receipts: 0,
          items: 0,
          costSum: 0,
          costMissing: false,
          returnedAmount: 0,
          returnedReceipts: 0,
          returnedItems: 0,
        };
        agg.revenue += row.revenue ?? 0;
        agg.receipts += row.receipts_count ?? 0;
        agg.items += row.items_count ?? 0;
        agg.returnedAmount += row.returned_amount ?? 0;
        agg.returnedReceipts += row.returned_receipts ?? 0;
        agg.returnedItems += row.returned_items ?? 0;
        // A missing value means "unknown", not zero — one day without cost
        // data makes the whole period's margin unknown, since averaging in
        // a false zero would inflate it.
        if (row.cost === null) agg.costMissing = true;
        else agg.costSum += row.cost;
        byRegister.set(row.register_id, agg);
      }

      const rows: RegisterSalesRow[] = [...byRegister.values()]
        .filter((a) => !a.store || selectedStores.includes(a.store))
        .map((a) => ({
          registerId: a.registerId,
          name: a.name,
          store: a.store,
          revenue: a.revenue,
          receipts: a.receipts,
          items: a.items,
          cost: a.costMissing ? null : a.costSum,
          returnedAmount: a.returnedAmount,
          returnedReceipts: a.returnedReceipts,
          returnedItems: a.returnedItems,
        }))
        .sort((a, b) => b.revenue - a.revenue);
      if (seq !== loadSeq.current) return; // a newer load() has since started — drop this stale result
      setRegisterSales(rows);

      type EmployeeAgg = {
        employeeId: string;
        name: string;
        store: string | null;
        revenue: number;
        receipts: number;
        items: number;
        costSum: number;
        costMissing: boolean;
        returnedAmount: number;
        returnedReceipts: number;
        returnedItems: number;
        shiftDays: Set<string>;
      };
      const byEmployee = new Map<string, EmployeeAgg>();
      for (const row of (employeeData ?? []) as unknown as {
        employee_ms_id: string;
        employee_name: string;
        store: string | null;
        sale_date: string;
        revenue: number;
        receipts_count: number;
        items_count: number;
        cost: number | null;
        returned_amount: number | null;
        returned_receipts: number | null;
        returned_items: number | null;
      }[]) {
        const key = `${row.employee_ms_id}|${row.store ?? ""}`;
        const agg = byEmployee.get(key) ?? {
          employeeId: row.employee_ms_id,
          name: row.employee_name,
          store: row.store,
          revenue: 0,
          receipts: 0,
          items: 0,
          costSum: 0,
          costMissing: false,
          returnedAmount: 0,
          returnedReceipts: 0,
          returnedItems: 0,
          shiftDays: new Set<string>(),
        };
        if ((row.receipts_count ?? 0) > 0 || (row.revenue ?? 0) > 0) agg.shiftDays.add(`${row.store ?? ""}|${row.sale_date}`);
        agg.revenue += row.revenue ?? 0;
        agg.receipts += row.receipts_count ?? 0;
        agg.items += row.items_count ?? 0;
        agg.returnedAmount += row.returned_amount ?? 0;
        agg.returnedReceipts += row.returned_receipts ?? 0;
        agg.returnedItems += row.returned_items ?? 0;
        if (row.cost === null) agg.costMissing = true;
        else agg.costSum += row.cost;
        byEmployee.set(key, agg);
      }
      const employeeRows: EmployeeSalesRow[] = [...byEmployee.values()]
        .filter((a) => !a.store || selectedStores.includes(a.store))
        .map((a) => ({
          employeeId: a.employeeId,
          name: a.name,
          store: a.store,
          revenue: a.revenue,
          receipts: a.receipts,
          items: a.items,
          cost: a.costMissing ? null : a.costSum,
          returnedAmount: a.returnedAmount,
          returnedReceipts: a.returnedReceipts,
          returnedItems: a.returnedItems,
          shiftTraffic: [...a.shiftDays].reduce((acc, k) => acc + (trafficByDay.get(k) ?? 0), 0),
        }))
        .sort((a, b) => b.revenue - a.revenue);
      setEmployeeSales(employeeRows);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setRegisterSales([]);
      setEmployeeSales([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodIndex, activeCustom?.start, activeCustom?.end, selectedStores.join(",")]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!showCustomPicker) return;
    function onClick(e: MouseEvent) {
      if (customPickerRef.current && !customPickerRef.current.contains(e.target as Node)) setShowCustomPicker(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showCustomPicker]);

  useEffect(() => {
    if (!showSortMenu) return;
    function onClick(e: MouseEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) setShowSortMenu(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showSortMenu]);

  function applyCustomRange() {
    if (!customStart || !customEnd || customStart > customEnd) return;
    setActiveCustom({ start: customStart, end: customEnd });
    setShowCustomPicker(false);
  }

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Продажа».</p>
      </div>
    );
  }

  // revenue/receipts/items on each row are already net of returns; when
  // showGross is on, this adds the returned amounts back for display only —
  // every sum here and below is derived from this, so nothing outside this
  // page (Статистика, KPIs, etc.) is ever affected by the toggle.
  function displayed(r: { revenue: number; receipts: number; items: number; returnedAmount: number; returnedReceipts: number; returnedItems: number }) {
    return showGross ? grossOf(r) : { revenue: r.revenue, receipts: r.receipts, items: r.items };
  }

  // Every register total below is computed from this, not registerSales
  // directly — a ticked-off register still renders (so it can be ticked
  // back on) but drops out of every subtotal and the grand total.
  const activeRegisterSales = registerSales.filter((r) => !hiddenRegisterIds.has(r.registerId));

  const totalRevenue = activeRegisterSales.reduce((acc, r) => acc + displayed(r).revenue, 0);
  const totalReceipts = activeRegisterSales.reduce((acc, r) => acc + displayed(r).receipts, 0);
  const totalItems = activeRegisterSales.reduce((acc, r) => acc + displayed(r).items, 0);
  const totalReturned = {
    returnedAmount: activeRegisterSales.reduce((acc, r) => acc + r.returnedAmount, 0),
    returnedReceipts: activeRegisterSales.reduce((acc, r) => acc + r.returnedReceipts, 0),
    returnedItems: activeRegisterSales.reduce((acc, r) => acc + r.returnedItems, 0),
  };

  // Конверсия = чек / посетитель × 100, тот же расчёт, что и на Статистике.
  // totalTraffic складывается из trafficByStore только по выбранным городам
  // (запрос уже отфильтрован по selectedStores), так что при смене фильтра
  // городов конверсия и знаменатель остаются согласованными.
  const totalTraffic = [...trafficByStore.values()].reduce((acc, n) => acc + n, 0);
  const overallConversionPct = totalTraffic > 0 ? (totalReceipts / totalTraffic) * 100 : null;

  function conversionLabel(receipts: number, traffic: number): string {
    return traffic > 0 ? `${((receipts / traffic) * 100).toFixed(1)}%` : "—";
  }

  // "0" when nothing was returned; otherwise a compact "sum · N чек · N тов."
  function returnSummary(r: { returnedAmount: number; returnedReceipts: number; returnedItems: number }): string {
    if (r.returnedAmount === 0 && r.returnedReceipts === 0 && r.returnedItems === 0) return "0";
    const parts = [money(r.returnedAmount)];
    if (r.returnedReceipts > 0) parts.push(`${r.returnedReceipts} чек`);
    if (r.returnedItems > 0) parts.push(`${r.returnedItems} тов.`);
    return parts.join(" · ");
  }

  // A missing cost anywhere in the set makes the whole sum's gross profit
  // unknown, rather than silently treating it as zero.
  function sumCost(rows: { cost: number | null }[]): number | null {
    let sum = 0;
    for (const r of rows) {
      if (r.cost === null) return null;
      sum += r.cost;
    }
    return sum;
  }
  function grossProfit(revenue: number, cost: number | null) {
    if (cost === null) return "—";
    const profit = revenue - cost;
    const margin = revenue !== 0 ? (profit / revenue) * 100 : 0;
    return (
      <>
        {money(profit)}
        <span className="text-mutedLight"> ({margin.toFixed(1)}%)</span>
      </>
    );
  }
  const totalCost = sumCost(activeRegisterSales);

  function storeLabel(code: string | null) {
    if (!code) return "—";
    return stores.find((s) => s.code === code)?.name ?? code;
  }

  // Grouped by city, in the same order cities appear everywhere else in the
  // app — Актау's points together, then Актобе's, each with its own subtotal.
  const cityGroups: { store: string | null; label: string; rows: RegisterSalesRow[] }[] = [
    ...stores.map((s) => ({ store: s.code, label: s.name, rows: [] as RegisterSalesRow[] })),
    { store: null, label: "Без города", rows: [] as RegisterSalesRow[] },
  ];
  for (const r of registerSales) {
    const group = cityGroups.find((g) => g.store === r.store) ?? cityGroups[cityGroups.length - 1];
    group.rows.push(r);
  }
  const visibleGroups = cityGroups.filter((g) => g.rows.length > 0);

  // Same grouping as the register table above, so "Продажи по сотрудникам"
  // gets its own Итого по Актау / Итого по Актобе subtotals.
  const employeeCityGroups: { store: string | null; label: string; rows: EmployeeSalesRow[] }[] = [
    ...stores.map((s) => ({ store: s.code, label: s.name, rows: [] as EmployeeSalesRow[] })),
    { store: null, label: "Без города", rows: [] as EmployeeSalesRow[] },
  ];
  for (const r of employeeSales) {
    const group = employeeCityGroups.find((g) => g.store === r.store) ?? employeeCityGroups[employeeCityGroups.length - 1];
    group.rows.push(r);
  }

  // Значение сотрудника по выбранному критерию сортировки — конверсия без
  // данных по трафику за период уходит в конец списка (а не в начало,
  // как было бы с 0), чтобы "нет данных" не выглядело как "хуже всех".
  function employeeMetric(r: EmployeeSalesRow, field: EmployeeSortField): number {
    const d = displayed(r);
    switch (field) {
      case "revenue":
        return d.revenue;
      case "receipts":
        return d.receipts;
      case "items":
        return d.items;
      case "avgCheck":
        return d.receipts > 0 ? d.revenue / d.receipts : 0;
      case "conversion": {
        const traffic = r.shiftTraffic;
        return traffic > 0 ? d.receipts / traffic : -Infinity;
      }
      case "depth":
        return d.receipts > 0 ? d.items / d.receipts : 0;
    }
  }
  for (const group of employeeCityGroups) {
    group.rows.sort((a, b) => employeeMetric(b, employeeSortField) - employeeMetric(a, employeeSortField));
  }

  const visibleEmployeeGroups = employeeCityGroups.filter((g) => g.rows.length > 0);

  const totalEmployeeRevenue = employeeSales.reduce((acc, r) => acc + displayed(r).revenue, 0);
  const totalEmployeeReceipts = employeeSales.reduce((acc, r) => acc + displayed(r).receipts, 0);
  const totalEmployeeItems = employeeSales.reduce((acc, r) => acc + displayed(r).items, 0);
  const totalEmployeeReturned = {
    returnedAmount: employeeSales.reduce((acc, r) => acc + r.returnedAmount, 0),
    returnedReceipts: employeeSales.reduce((acc, r) => acc + r.returnedReceipts, 0),
    returnedItems: employeeSales.reduce((acc, r) => acc + r.returnedItems, 0),
  };

  function groupTotals(rows: EmployeeSalesRow[]) {
    const revenue = rows.reduce((acc, r) => acc + displayed(r).revenue, 0);
    const receipts = rows.reduce((acc, r) => acc + displayed(r).receipts, 0);
    const items = rows.reduce((acc, r) => acc + displayed(r).items, 0);
    const returned = {
      returnedAmount: rows.reduce((acc, r) => acc + r.returnedAmount, 0),
      returnedReceipts: rows.reduce((acc, r) => acc + r.returnedReceipts, 0),
      returnedItems: rows.reduce((acc, r) => acc + r.returnedItems, 0),
    };
    const cost = sumCost(rows);
    return { revenue, receipts, items, returned, cost };
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Общее</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Продажа</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Продажи по кассам из МойСклад — обновляются раз в сутки, здесь ничего не считается
          в реальном времени. Возврат вычитается из дня, когда он произошёл: сумма и товар — всегда,
          а сам чек — если вернули всё, что в нём было.
        </p>
        {error && (
          <div className="flex items-center gap-3 text-sm text-[#A34B36]">
            <span>{error}</span>
            <button type="button" onClick={load} className="font-semibold underline">
              Повторить
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap bg-surface border border-border rounded-card p-1.5 w-fit relative">
        {PERIODS.map((p, i) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setPeriodIndex(i);
              setActiveCustom(null);
            }}
            disabled={loading}
            className={`font-sans text-[13px] rounded-md px-3.5 py-2 disabled:opacity-60 ${
              i === periodIndex && !activeCustom ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {p}
          </button>
        ))}
        <div className="w-px h-5 bg-border mx-0.5" />
        <div ref={customPickerRef} className="relative">
          <button
            type="button"
            onClick={() => {
              if (!showCustomPicker) {
                setCustomStart(activeCustom?.start ?? ymd(addDays(new Date(), -6)));
                setCustomEnd(activeCustom?.end ?? ymd(new Date()));
              }
              setShowCustomPicker((v) => !v);
            }}
            disabled={loading}
            className={`text-[13px] rounded-md px-3.5 py-2 disabled:opacity-60 ${
              activeCustom ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {activeCustom ? `${activeCustom.start} — ${activeCustom.end}` : "Свой период"}
          </button>
          {showCustomPicker && (
            <div className="absolute right-0 top-full mt-2 z-50 bg-surface border border-border rounded-lg shadow-lg p-3.5 flex flex-col gap-2.5 w-[230px]">
              <label className="flex flex-col gap-1 text-xs text-muted">
                С
                <input
                  type="date"
                  value={customStart}
                  max={customEnd || undefined}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="border border-border rounded-md px-2 py-1.5 text-[13px] bg-paper text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                По
                <input
                  type="date"
                  value={customEnd}
                  min={customStart || undefined}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="border border-border rounded-md px-2 py-1.5 text-[13px] bg-paper text-ink"
                />
              </label>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCustomPicker(false)}
                  className="text-[12.5px] font-semibold text-muted px-2.5 py-1.5 rounded-md hover:bg-paper"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={applyCustomRange}
                  disabled={!customStart || !customEnd || customStart > customEnd}
                  className="text-[12.5px] font-bold text-paper bg-accent rounded-md px-3 py-1.5 disabled:opacity-50"
                >
                  Применить
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end -mt-2">
        <PdfButton
          disabled={loading || registerSales.length === 0}
          build={(): PdfDoc => {
            const r = activeCustom
              ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
              : getPeriodRange(periodIndex, new Date());
            const ru = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
            const periodLabel = activeCustom ? "Свой период" : PERIODS[periodIndex];
            const profitText = (revenue: number, cost: number | null) => {
              if (cost === null) return "—";
              const profit = revenue - cost;
              return `${money(profit)} (${(revenue !== 0 ? (profit / revenue) * 100 : 0).toFixed(1)}%)`;
            };
            const costText = (cost: number | null) => (cost === null ? "—" : money(cost));
            const avg = (revenue: number, receipts: number) => (receipts > 0 ? money(revenue / receipts) : "—");
            const depth = (items: number, receipts: number) => (receipts > 0 ? (items / receipts).toFixed(1) : "—");

            // Кассы по городам, с итогом города и общим итогом
            const regRows: (string | number)[][] = [];
            const regKinds: ("normal" | "group" | "total")[] = [];
            const regPick: string[] = [];
            for (const g of visibleGroups) {
              const active = g.rows.filter((x) => !hiddenRegisterIds.has(x.registerId));
              regRows.push([`Город: ${g.label}`, "", "", "", "", "", "", "", ""]);
              regKinds.push("group");
              regPick.push(`Город «${g.label}» — строка-заголовок`);
              for (const x of active) {
                const d = displayed(x);
                regRows.push([x.name, money(d.revenue), d.receipts, d.items, avg(d.revenue, d.receipts), depth(d.items, d.receipts), returnSummary(x), costText(x.cost), profitText(d.revenue, x.cost)]);
                regKinds.push("normal");
                regPick.push(`Касса «${x.name}» (город ${g.label})`);
              }
              const gRev = active.reduce((a, x) => a + displayed(x).revenue, 0);
              const gRec = active.reduce((a, x) => a + displayed(x).receipts, 0);
              const gItems = active.reduce((a, x) => a + displayed(x).items, 0);
              const gRet = {
                returnedAmount: active.reduce((a, x) => a + x.returnedAmount, 0),
                returnedReceipts: active.reduce((a, x) => a + x.returnedReceipts, 0),
                returnedItems: active.reduce((a, x) => a + x.returnedItems, 0),
              };
              regRows.push([`Итого: ${g.label}`, money(gRev), gRec, gItems, avg(gRev, gRec), depth(gItems, gRec), returnSummary(gRet), costText(sumCost(active)), profitText(gRev, sumCost(active))]);
              regKinds.push("total");
              regPick.push(`Итого по городу ${g.label}`);
            }
            regRows.push(["Итого", money(totalRevenue), totalReceipts, totalItems, avg(totalRevenue, totalReceipts), depth(totalItems, totalReceipts), returnSummary(totalReturned), costText(totalCost), profitText(totalRevenue, totalCost)]);
            regKinds.push("total");
            regPick.push("Общий итог");

            // Сотрудники по городам
            const empRows: (string | number)[][] = [];
            const empKinds: ("normal" | "group" | "total")[] = [];
            const empPick: string[] = [];
            for (const g of visibleEmployeeGroups) {
              const gt = groupTotals(g.rows);
              const traffic = [...new Set(g.rows.map((x) => x.store ?? ""))].reduce((a, c) => a + (trafficByStore.get(c) ?? 0), 0);
              empRows.push([`Город: ${g.label}`, "", "", "", "", "", "", "", ""]);
              empKinds.push("group");
              empPick.push(`Город «${g.label}» — строка-заголовок`);
              for (const x of g.rows) {
                const d = displayed(x);
                empRows.push([x.name, money(d.revenue), d.receipts, d.items, avg(d.revenue, d.receipts), depth(d.items, d.receipts), conversionLabel(d.receipts, x.shiftTraffic), costText(x.cost), profitText(d.revenue, x.cost)]);
                empKinds.push("normal");
                empPick.push(`Сотрудник ${x.name} (город ${g.label})`);
              }
              empRows.push([`Итого: ${g.label}`, money(gt.revenue), gt.receipts, gt.items, avg(gt.revenue, gt.receipts), depth(gt.items, gt.receipts), conversionLabel(gt.receipts, traffic), costText(gt.cost), profitText(gt.revenue, gt.cost)]);
              empKinds.push("total");
              empPick.push(`Итого по городу ${g.label}`);
            }

            const sections: PdfDoc["sections"] = [
              {
                title: "Продажи по кассам",
                note: showGross ? "Суммы без учёта возвратов." : "Суммы с учётом возвратов (возврат вычтен из дня, когда он произошёл).",
                headers: ["Касса", "Выручка", "Чеков", "Товаров", "Средний чек", "Глубина чека", "Возврат", "Себестоимость", "Валовая прибыль"],
                groupCols: { cost: [7, 8] },
                align: ["left", "right", "right", "right", "right", "right", "right", "right", "right"],
                widths: [2.2, 1.5, 0.8, 0.9, 1.3, 1, 1.8, 1.5, 2],
                rows: regRows,
                rowKinds: regKinds,
                pickLabels: regPick,
              },
            ];
            if (empRows.length > 0) {
              sections.push({
                title: "Продажи по сотрудникам",
                note: "Конверсия — доля трафика города за дни смен сотрудника, обращённая в его чеки.",
                headers: ["Сотрудник", "Выручка", "Чеков", "Товаров", "Средний чек", "Глубина чека", "Конверсия", "Себестоимость", "Валовая прибыль"],
                groupCols: { cost: [7, 8], conversion: [6] },
                align: ["left", "right", "right", "right", "right", "right", "right", "right", "right"],
                widths: [2.2, 1.5, 0.8, 0.9, 1.3, 1, 1.2, 1.5, 2],
                rows: empRows,
                rowKinds: empKinds,
                pickLabels: empPick,
              });
            }
            return {
              fileName: `Продажа_${ymd(r.start)}_${ymd(r.end)}`,
              title: "Продажи по кассам и сотрудникам",
              subtitle: `${periodLabel}: ${ru(r.start)} — ${ru(r.end)}`,
              orientation: "landscape",
              kpis: [
                { label: "Выручка", value: money(totalRevenue) },
                { label: "Чеков", value: totalReceipts.toLocaleString("ru-RU") },
                { label: "Средний чек", value: avg(totalRevenue, totalReceipts) },
                { label: "Конверсия", group: "conversion" as const, value: overallConversionPct !== null ? `${overallConversionPct.toFixed(1)}%` : "—", note: totalTraffic > 0 ? `${Math.round(totalTraffic).toLocaleString("ru-RU")} посетителей` : undefined },
              ],
              sections,
            };
          }}
        />
      </div>

      <SalesPlanWindow stores={selectedStores} refreshKey={planVersion} range={planRange} />

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-1.5 w-fit">
        <div className="text-xs text-muted">Конверсия (чек / посетитель)</div>
        <div className="font-serif text-[26px] font-semibold num">
          {loading ? "…" : overallConversionPct !== null ? `${overallConversionPct.toFixed(1)}%` : "—"}
        </div>
        <div className="text-xs text-mutedLight">
          {loading
            ? "Загрузка…"
            : totalTraffic > 0
              ? `${totalReceipts.toLocaleString("ru-RU")} чек из ${totalTraffic.toLocaleString("ru-RU")} посетителей`
              : "нет данных по трафику за этот период"}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        <div className="text-[15px] font-bold flex items-center gap-2 flex-wrap">
          <span>
            Продажи по кассам{" "}
            <button
              type="button"
              onClick={() => setShowGross((v) => !v)}
              className="text-muted font-normal text-[12.5px] hover:underline"
            >
              ({showGross ? "без учёта возврата" : "с учётом возврата"})
            </button>
          </span>
          {hiddenRegisterIds.size > 0 && (
            <button
              type="button"
              onClick={() => setHiddenRegisterIds(new Set())}
              className="text-[12px] font-normal text-mutedLight hover:underline"
            >
              скрыто касс: {hiddenRegisterIds.size} · показать все
            </button>
          )}
        </div>
        {loading ? (
          <div className="text-sm text-muted py-4">Загрузка…</div>
        ) : registerSales.length === 0 ? (
          <div className="text-sm text-muted py-4">Нет данных за этот период.</div>
        ) : mobileLayout ? (
          <div className="flex flex-col gap-3">
            {visibleGroups.map((group) => {
              const activeRows = group.rows.filter((r) => !hiddenRegisterIds.has(r.registerId));
              const groupRevenue = activeRows.reduce((acc, r) => acc + displayed(r).revenue, 0);
              const groupReceipts = activeRows.reduce((acc, r) => acc + displayed(r).receipts, 0);
              const groupItems = activeRows.reduce((acc, r) => acc + displayed(r).items, 0);
              const groupReturned = {
                returnedAmount: activeRows.reduce((acc, r) => acc + r.returnedAmount, 0),
                returnedReceipts: activeRows.reduce((acc, r) => acc + r.returnedReceipts, 0),
                returnedItems: activeRows.reduce((acc, r) => acc + r.returnedItems, 0),
              };
              const groupCost = sumCost(activeRows);
              return (
                <div key={group.store ?? "none"} className="flex flex-col gap-2">
                  {group.rows.map((r) => {
                    const d = displayed(r);
                    const avgCheck = d.receipts > 0 ? d.revenue / d.receipts : 0;
                    const checkDepth = d.receipts > 0 ? d.items / d.receipts : 0;
                    const hidden = hiddenRegisterIds.has(r.registerId);
                    return (
                      <div
                        key={r.registerId}
                        className={`flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px] ${hidden ? "opacity-40" : ""}`}
                      >
                        <label className="font-semibold flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!hidden}
                            onChange={() => toggleRegisterHidden(r.registerId)}
                            className="accent-accent"
                            title="Учитывать в итогах"
                          />
                          {r.name} <span className="text-muted font-normal">· {storeLabel(r.store)}</span>
                        </label>
                        <SalesField
                          label="Выручка"
                          value={money(d.revenue)}
                          extra={!showGross && r.returnedAmount > 0 ? `(${money(r.returnedAmount)})` : null}
                        />
                        <SalesField
                          label="Чеков"
                          value={String(d.receipts)}
                          extra={!showGross && r.returnedReceipts > 0 ? `(${r.returnedReceipts})` : null}
                        />
                        <SalesField label="Средний чек" value={money(avgCheck)} />
                        <SalesField
                          label="Кол-во товара"
                          value={d.items.toLocaleString("ru-RU")}
                          extra={!showGross && r.returnedItems > 0 ? `(${r.returnedItems})` : null}
                        />
                        <SalesField label="Глубина чека" value={checkDepth.toFixed(3)} />
                        <SalesField label="Вал. прибыль" value={grossProfit(d.revenue, r.cost)} />
                        <SalesField label="Возврат" value={returnSummary(r)} />
                      </div>
                    );
                  })}
                  {activeRows.length > 1 && (
                    <div className="flex flex-col gap-1 rounded-lg border border-[#E4DFC8] bg-weekendTint p-3 text-[13px] font-bold">
                      <div>Итого по {group.label}</div>
                      <SalesField
                        label="Выручка"
                        value={money(groupRevenue)}
                        extra={!showGross && groupReturned.returnedAmount > 0 ? `(${money(groupReturned.returnedAmount)})` : null}
                      />
                      <SalesField
                        label="Чеков"
                        value={String(groupReceipts)}
                        extra={!showGross && groupReturned.returnedReceipts > 0 ? `(${groupReturned.returnedReceipts})` : null}
                      />
                      <SalesField label="Средний чек" value={groupReceipts > 0 ? money(groupRevenue / groupReceipts) : "—"} />
                      <SalesField
                        label="Кол-во товара"
                        value={groupItems.toLocaleString("ru-RU")}
                        extra={!showGross && groupReturned.returnedItems > 0 ? `(${groupReturned.returnedItems})` : null}
                      />
                      <SalesField label="Глубина чека" value={groupReceipts > 0 ? (groupItems / groupReceipts).toFixed(3) : "—"} />
                      <SalesField label="Вал. прибыль" value={grossProfit(groupRevenue, groupCost)} />
                      <SalesField label="Возврат" value={returnSummary(groupReturned)} />
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex flex-col gap-1 rounded-lg border border-[#E4DFC8] p-3 text-[13px] font-bold">
              <div>Итого</div>
              <SalesField
                label="Выручка"
                value={money(totalRevenue)}
                extra={!showGross && totalReturned.returnedAmount > 0 ? `(${money(totalReturned.returnedAmount)})` : null}
              />
              <SalesField
                label="Чеков"
                value={String(totalReceipts)}
                extra={!showGross && totalReturned.returnedReceipts > 0 ? `(${totalReturned.returnedReceipts})` : null}
              />
              <SalesField label="Средний чек" value={totalReceipts > 0 ? money(totalRevenue / totalReceipts) : "—"} />
              <SalesField
                label="Кол-во товара"
                value={totalItems.toLocaleString("ru-RU")}
                extra={!showGross && totalReturned.returnedItems > 0 ? `(${totalReturned.returnedItems})` : null}
              />
              <SalesField label="Глубина чека" value={totalReceipts > 0 ? (totalItems / totalReceipts).toFixed(3) : "—"} />
              <SalesField label="Вал. прибыль" value={grossProfit(totalRevenue, totalCost)} />
              <SalesField label="Возврат" value={returnSummary(totalReturned)} />
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[960px] grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Касса</div>
              <div>Город</div>
              <div>Выручка</div>
              <div>Чеков</div>
              <div>Средний чек</div>
              <div>Кол-во товара</div>
              <div>Глубина чека</div>
              <div>Вал. прибыль</div>
              <div>Возврат</div>
            </div>
            {visibleGroups.map((group) => {
              const activeRows = group.rows.filter((r) => !hiddenRegisterIds.has(r.registerId));
              const groupRevenue = activeRows.reduce((acc, r) => acc + displayed(r).revenue, 0);
              const groupReceipts = activeRows.reduce((acc, r) => acc + displayed(r).receipts, 0);
              const groupItems = activeRows.reduce((acc, r) => acc + displayed(r).items, 0);
              const groupReturned = {
                returnedAmount: activeRows.reduce((acc, r) => acc + r.returnedAmount, 0),
                returnedReceipts: activeRows.reduce((acc, r) => acc + r.returnedReceipts, 0),
                returnedItems: activeRows.reduce((acc, r) => acc + r.returnedItems, 0),
              };
              const groupCost = sumCost(activeRows);
              return (
                <div key={group.store ?? "none"}>
                  {group.rows.map((r) => {
                    const d = displayed(r);
                    const avgCheck = d.receipts > 0 ? d.revenue / d.receipts : 0;
                    const checkDepth = d.receipts > 0 ? d.items / d.receipts : 0;
                    const hidden = hiddenRegisterIds.has(r.registerId);
                    return (
                      <div
                        key={r.registerId}
                        className={`min-w-[960px] grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px] ${hidden ? "opacity-40" : ""}`}
                      >
                        <label className="font-semibold flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!hidden}
                            onChange={() => toggleRegisterHidden(r.registerId)}
                            className="accent-accent"
                            title="Учитывать в итогах"
                          />
                          {r.name}
                        </label>
                        <div className="text-muted">{storeLabel(r.store)}</div>
                        <div className="num">
                          {money(d.revenue)}
                          {!showGross && r.returnedAmount > 0 && (
                            <span className="text-mutedLight"> ({money(r.returnedAmount)})</span>
                          )}
                        </div>
                        <div className="num">
                          {d.receipts}
                          {!showGross && r.returnedReceipts > 0 && (
                            <span className="text-mutedLight"> ({r.returnedReceipts})</span>
                          )}
                        </div>
                        <div className="num">{money(avgCheck)}</div>
                        <div className="num">
                          {d.items.toLocaleString("ru-RU")}
                          {!showGross && r.returnedItems > 0 && (
                            <span className="text-mutedLight"> ({r.returnedItems})</span>
                          )}
                        </div>
                        <div className="num">{checkDepth.toFixed(3)}</div>
                        <div className="num">{grossProfit(d.revenue, r.cost)}</div>
                        <div className="num text-muted">{returnSummary(r)}</div>
                      </div>
                    );
                  })}
                  {activeRows.length > 1 && (
                    <div className="min-w-[960px] grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 py-2 border-b border-borderSoft items-center text-[12.5px] font-bold bg-weekendTint">
                      <div className="col-span-2">Итого по {group.label}</div>
                      <div className="num">
                        {money(groupRevenue)}
                        {!showGross && groupReturned.returnedAmount > 0 && (
                          <span className="text-mutedLight font-normal"> ({money(groupReturned.returnedAmount)})</span>
                        )}
                      </div>
                      <div className="num">
                        {groupReceipts}
                        {!showGross && groupReturned.returnedReceipts > 0 && (
                          <span className="text-mutedLight font-normal"> ({groupReturned.returnedReceipts})</span>
                        )}
                      </div>
                      <div className="num">{groupReceipts > 0 ? money(groupRevenue / groupReceipts) : "—"}</div>
                      <div className="num">
                        {groupItems.toLocaleString("ru-RU")}
                        {!showGross && groupReturned.returnedItems > 0 && (
                          <span className="text-mutedLight font-normal"> ({groupReturned.returnedItems})</span>
                        )}
                      </div>
                      <div className="num">{groupReceipts > 0 ? (groupItems / groupReceipts).toFixed(3) : "—"}</div>
                      <div className="num">{grossProfit(groupRevenue, groupCost)}</div>
                      <div className="num text-muted font-normal">{returnSummary(groupReturned)}</div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="min-w-[960px] grid grid-cols-[1.2fr_0.8fr_1fr_0.55fr_0.9fr_0.85fr_0.8fr_0.8fr_1.1fr] gap-3 pt-2.5 border-t-2 border-[#E4DFC8] text-[13px] font-bold">
              <div className="col-span-2">Итого</div>
              <div className="num">
                {money(totalRevenue)}
                {!showGross && totalReturned.returnedAmount > 0 && (
                  <span className="text-mutedLight font-normal"> ({money(totalReturned.returnedAmount)})</span>
                )}
              </div>
              <div className="num">
                {totalReceipts}
                {!showGross && totalReturned.returnedReceipts > 0 && (
                  <span className="text-mutedLight font-normal"> ({totalReturned.returnedReceipts})</span>
                )}
              </div>
              <div className="num">{totalReceipts > 0 ? money(totalRevenue / totalReceipts) : "—"}</div>
              <div className="num">
                {totalItems.toLocaleString("ru-RU")}
                {!showGross && totalReturned.returnedItems > 0 && (
                  <span className="text-mutedLight font-normal"> ({totalReturned.returnedItems})</span>
                )}
              </div>
              <div className="num">{totalReceipts > 0 ? (totalItems / totalReceipts).toFixed(3) : "—"}</div>
              <div className="num">{grossProfit(totalRevenue, totalCost)}</div>
              <div className="num text-muted font-normal">{returnSummary(totalReturned)}</div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        <div className="text-[15px] font-bold flex items-center gap-2 flex-wrap">
          <span>Продажи по сотрудникам</span>
          <div ref={sortMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setShowSortMenu((v) => !v)}
              className="text-muted font-normal text-[12.5px] hover:underline"
            >
              Сортировка: {EMPLOYEE_SORT_FIELDS.find((f) => f.key === employeeSortField)?.label} ↓
            </button>
            {showSortMenu && (
              <div className="absolute left-0 top-full mt-2 z-50 bg-surface border border-border rounded-lg shadow-lg py-1.5 w-[200px]">
                {EMPLOYEE_SORT_FIELDS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => {
                      setEmployeeSortField(f.key);
                      setShowSortMenu(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-paper ${
                      employeeSortField === f.key ? "font-bold text-ink" : "text-muted font-normal"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {loading ? (
          <div className="text-sm text-muted py-4">Загрузка…</div>
        ) : employeeSales.length === 0 ? (
          <div className="text-sm text-muted py-4">Нет данных за этот период.</div>
        ) : mobileLayout ? (
          <div className="flex flex-col gap-3">
            {visibleEmployeeGroups.map((group) => {
              const g = groupTotals(group.rows);
              return (
                <div key={group.store ?? "none"} className="flex flex-col gap-2">
                  <div className="text-[11px] uppercase tracking-wide text-mutedLight">{group.label}</div>
                  {group.rows.map((r) => (
                    <div key={`${r.employeeId}|${r.store ?? ""}`} className="flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px]">
                      <div className="font-semibold">{r.name}</div>
                      <SalesField
                        label="Выручка"
                        value={money(displayed(r).revenue)}
                        extra={!showGross && r.returnedAmount > 0 ? `(${money(r.returnedAmount)})` : null}
                      />
                      <SalesField
                        label="Чеков"
                        value={String(displayed(r).receipts)}
                        extra={!showGross && r.returnedReceipts > 0 ? `(${r.returnedReceipts})` : null}
                      />
                      <SalesField
                        label="Кол-во товара"
                        value={displayed(r).items.toLocaleString("ru-RU")}
                        extra={!showGross && r.returnedItems > 0 ? `(${r.returnedItems})` : null}
                      />
                      <SalesField
                        label="Средний чек"
                        value={displayed(r).receipts > 0 ? money(displayed(r).revenue / displayed(r).receipts) : "—"}
                      />
                      <SalesField
                        label="Конверсия"
                        value={conversionLabel(displayed(r).receipts, r.shiftTraffic)}
                      />
                      <SalesField
                        label="Глубина чека"
                        value={displayed(r).receipts > 0 ? (displayed(r).items / displayed(r).receipts).toFixed(3) : "—"}
                      />
                    </div>
                  ))}
                  {group.rows.length > 1 && (
                    <div className="flex flex-col gap-1 rounded-lg border border-borderSoft bg-weekendTint p-3 text-[13px] font-bold">
                      <div>Итого по {group.label}</div>
                      <SalesField
                        label="Выручка"
                        value={money(g.revenue)}
                        extra={!showGross && g.returned.returnedAmount > 0 ? `(${money(g.returned.returnedAmount)})` : null}
                      />
                      <SalesField
                        label="Чеков"
                        value={String(g.receipts)}
                        extra={!showGross && g.returned.returnedReceipts > 0 ? `(${g.returned.returnedReceipts})` : null}
                      />
                      <SalesField
                        label="Кол-во товара"
                        value={g.items.toLocaleString("ru-RU")}
                        extra={!showGross && g.returned.returnedItems > 0 ? `(${g.returned.returnedItems})` : null}
                      />
                      <SalesField label="Средний чек" value={g.receipts > 0 ? money(g.revenue / g.receipts) : "—"} />
                      <SalesField
                        label="Конверсия"
                        value={conversionLabel(g.receipts, trafficByStore.get(group.store ?? "") ?? 0)}
                      />
                      <SalesField label="Глубина чека" value={g.receipts > 0 ? (g.items / g.receipts).toFixed(3) : "—"} />
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex flex-col gap-1 rounded-lg border border-[#E4DFC8] p-3 text-[13px] font-bold">
              <div>Итого</div>
              <SalesField
                label="Выручка"
                value={money(totalEmployeeRevenue)}
                extra={!showGross && totalEmployeeReturned.returnedAmount > 0 ? `(${money(totalEmployeeReturned.returnedAmount)})` : null}
              />
              <SalesField
                label="Чеков"
                value={String(totalEmployeeReceipts)}
                extra={!showGross && totalEmployeeReturned.returnedReceipts > 0 ? `(${totalEmployeeReturned.returnedReceipts})` : null}
              />
              <SalesField
                label="Кол-во товара"
                value={totalEmployeeItems.toLocaleString("ru-RU")}
                extra={!showGross && totalEmployeeReturned.returnedItems > 0 ? `(${totalEmployeeReturned.returnedItems})` : null}
              />
              <SalesField
                label="Средний чек"
                value={totalEmployeeReceipts > 0 ? money(totalEmployeeRevenue / totalEmployeeReceipts) : "—"}
              />
              <SalesField label="Конверсия" value={conversionLabel(totalEmployeeReceipts, totalTraffic)} />
              <SalesField
                label="Глубина чека"
                value={totalEmployeeReceipts > 0 ? (totalEmployeeItems / totalEmployeeReceipts).toFixed(3) : "—"}
              />
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[880px] grid grid-cols-[1.2fr_1fr_0.55fr_0.8fr_0.9fr_0.7fr_0.8fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Сотрудник</div>
              <div>Выручка</div>
              <div>Чеков</div>
              <div>Кол-во товара</div>
              <div>Средний чек</div>
              <div>Конверсия</div>
              <div>Глубина чека</div>
            </div>
            {visibleEmployeeGroups.map((group) => {
              const g = groupTotals(group.rows);
              return (
                <div key={group.store ?? "none"}>
                  <div className="min-w-[880px] pt-2.5 pb-1 text-[10.5px] uppercase tracking-wide text-mutedLight">
                    {group.label}
                  </div>
                  {group.rows.map((r) => {
                    const d = displayed(r);
                    const avgCheck = d.receipts > 0 ? d.revenue / d.receipts : 0;
                    const checkDepth = d.receipts > 0 ? d.items / d.receipts : 0;
                    return (
                      <div
                        key={`${r.employeeId}|${r.store ?? ""}`}
                        className="min-w-[880px] grid grid-cols-[1.2fr_1fr_0.55fr_0.8fr_0.9fr_0.7fr_0.8fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
                      >
                        <div className="font-semibold">{r.name}</div>
                        <div className="num">
                          {money(d.revenue)}
                          {!showGross && r.returnedAmount > 0 && (
                            <span className="text-mutedLight"> ({money(r.returnedAmount)})</span>
                          )}
                        </div>
                        <div className="num">
                          {d.receipts}
                          {!showGross && r.returnedReceipts > 0 && (
                            <span className="text-mutedLight"> ({r.returnedReceipts})</span>
                          )}
                        </div>
                        <div className="num">
                          {d.items.toLocaleString("ru-RU")}
                          {!showGross && r.returnedItems > 0 && (
                            <span className="text-mutedLight"> ({r.returnedItems})</span>
                          )}
                        </div>
                        <div className="num">{money(avgCheck)}</div>
                        <div className="num">{conversionLabel(d.receipts, r.shiftTraffic)}</div>
                        <div className="num">{checkDepth.toFixed(3)}</div>
                      </div>
                    );
                  })}
                  {group.rows.length > 1 && (
                    <div className="min-w-[880px] grid grid-cols-[1.2fr_1fr_0.55fr_0.8fr_0.9fr_0.7fr_0.8fr] gap-3 py-2 border-b border-borderSoft items-center text-[12.5px] font-bold bg-weekendTint">
                      <div>Итого по {group.label}</div>
                      <div className="num">
                        {money(g.revenue)}
                        {!showGross && g.returned.returnedAmount > 0 && (
                          <span className="text-mutedLight font-normal"> ({money(g.returned.returnedAmount)})</span>
                        )}
                      </div>
                      <div className="num">
                        {g.receipts}
                        {!showGross && g.returned.returnedReceipts > 0 && (
                          <span className="text-mutedLight font-normal"> ({g.returned.returnedReceipts})</span>
                        )}
                      </div>
                      <div className="num">
                        {g.items.toLocaleString("ru-RU")}
                        {!showGross && g.returned.returnedItems > 0 && (
                          <span className="text-mutedLight font-normal"> ({g.returned.returnedItems})</span>
                        )}
                      </div>
                      <div className="num">{g.receipts > 0 ? money(g.revenue / g.receipts) : "—"}</div>
                      <div className="num">{conversionLabel(g.receipts, trafficByStore.get(group.store ?? "") ?? 0)}</div>
                      <div className="num">{g.receipts > 0 ? (g.items / g.receipts).toFixed(3) : "—"}</div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="min-w-[880px] grid grid-cols-[1.2fr_1fr_0.55fr_0.8fr_0.9fr_0.7fr_0.8fr] gap-3 pt-2.5 border-t-2 border-[#E4DFC8] text-[13px] font-bold">
              <div>Итого</div>
              <div className="num">
                {money(totalEmployeeRevenue)}
                {!showGross && totalEmployeeReturned.returnedAmount > 0 && (
                  <span className="text-mutedLight font-normal"> ({money(totalEmployeeReturned.returnedAmount)})</span>
                )}
              </div>
              <div className="num">
                {totalEmployeeReceipts}
                {!showGross && totalEmployeeReturned.returnedReceipts > 0 && (
                  <span className="text-mutedLight font-normal"> ({totalEmployeeReturned.returnedReceipts})</span>
                )}
              </div>
              <div className="num">
                {totalEmployeeItems.toLocaleString("ru-RU")}
                {!showGross && totalEmployeeReturned.returnedItems > 0 && (
                  <span className="text-mutedLight font-normal"> ({totalEmployeeReturned.returnedItems})</span>
                )}
              </div>
              <div className="num">{totalEmployeeReceipts > 0 ? money(totalEmployeeRevenue / totalEmployeeReceipts) : "—"}</div>
              <div className="num">{conversionLabel(totalEmployeeReceipts, totalTraffic)}</div>
              <div className="num">
                {totalEmployeeReceipts > 0 ? (totalEmployeeItems / totalEmployeeReceipts).toFixed(3) : "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      <SalesPlanEntry onSaved={() => setPlanVersion((v) => v + 1)} />
    </>
  );
}
