"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useSiteVersion } from "@/components/SiteVersion";
import { useStoreSelection } from "@/components/StoreSelection";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

// No period selector here on purpose — АВС/XYZ is a rolling classification,
// not a report for a chosen range. 90 days is long enough that "Дней"
// (days-with-sales ratio, which XYZ is based on) is a meaningful signal
// rather than noise from a short window.
const WINDOW_DAYS = 90;

const ABC_OPTIONS = [
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
];
const XYZ_OPTIONS = [
  { value: "X", label: "X" },
  { value: "Y", label: "Y" },
  { value: "Z", label: "Z" },
];
type AbcKey = "A" | "B" | "C";
type XyzKey = "X" | "Y" | "Z";

const DECISIONS: Record<string, string> = {
  AX: "лидер, стабильный спрос — держать в наличии всегда",
  AY: "важен, спрос скачет — держать страховой запас",
  AZ: "деньги редкими вспышками — заказывать точечно, под всплеск",
  BX: "стабильный, средний вклад — поддерживать наличие",
  BY: "средний, неровный спрос — заказывать чаще малыми партиями",
  BZ: "редкий спрос — заказывать под конкретный заказ",
  CX: "низкий вклад, но стабилен — держать минимальный запас",
  CY: "низкий вклад, неровный спрос — не приоритет для закупки",
  CZ: "почти не продаётся — кандидат на исключение из ассортимента",
};

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

type ProductRow = {
  id: string;
  name: string;
  category: string;
  revenue: number;
  quantity: number;
  cost: number;
  daysWithSales: number;
  abc: AbcKey;
  xyz: XyzKey;
};

// Paginates any Supabase query/rpc past PostgREST's default row cap — the
// catalog is ~5-6k products, easily past 1000 rows once summed over 90 days.
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const pageSize = 1000;
  let offset = 0;
  const all: T[] = [];
  for (;;) {
    const { data, error } = await build(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="flex flex-col gap-1.5" ref={ref}>
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full min-w-[180px] flex items-center justify-between gap-2 bg-paper border border-border rounded-lg px-3 py-2 text-[13px]"
        >
          <span className="flex items-center gap-1.5 flex-wrap">
            {selected.length === 0 ? (
              <span className="text-mutedLight">Все</span>
            ) : (
              selected.map((v) => (
                <span
                  key={v}
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(v);
                  }}
                  className="inline-flex items-center gap-1 bg-[#A34B36] text-white text-[11px] font-bold rounded-md px-1.5 py-0.5"
                >
                  {options.find((o) => o.value === v)?.label ?? v} ×
                </span>
              ))
            )}
          </span>
          <span className="flex items-center gap-1.5 flex-none">
            {selected.length > 0 && (
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                className="text-mutedLight text-[13px]"
              >
                ✕
              </span>
            )}
            <span className="text-mutedLight text-[10px]">{open ? "▲" : "▼"}</span>
          </span>
        </button>
        {open && (
          <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg p-2 flex flex-col gap-1 shadow-lg max-h-[260px] overflow-y-auto min-w-[220px]">
            {options.map((o) => (
              <label
                key={o.value}
                className="flex items-center gap-2 text-[13px] py-1.5 px-1.5 rounded-md hover:bg-paper cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={() => onToggle(o.value)}
                  className="accent-accent"
                />
                {o.label}
              </label>
            ))}
            {options.length === 0 && <div className="text-[13px] text-mutedLight px-1.5 py-1">Нет вариантов</div>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AbcXyzPage() {
  const { isAdmin, permissions } = useAuth();
  const { mobileLayout } = useSiteVersion();
  const { selected: selectedStores } = useStoreSelection();
  const canView = isAdmin || permissions["warehouse.stock"].canView;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [abcFilter, setAbcFilter] = useState<string[]>([]);
  const [xyzFilter, setXyzFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const today = new Date();
      const from = ymd(addDays(today, -(WINDOW_DAYS - 1)));
      const to = ymd(today);
      type Raw = {
        product_ms_id: string;
        product_name: string;
        category: string | null;
        revenue: number;
        quantity: number;
        cost: number;
        days_with_sales: number;
      };
      const raw = await fetchAllRows<Raw>((from_, to_) =>
        supabase.rpc("product_sales_summary", { p_from: from, p_to: to, p_stores: selectedStores }).range(from_, to_)
      );

      // Only products with real net revenue in the window get classified —
      // a product with zero (or return-only) sales here has nothing to rank
      // by ABC and belongs to the separate "Зависшие остатки" page instead.
      const withRevenue = raw.filter((r) => r.revenue > 0);
      withRevenue.sort((a, b) => b.revenue - a.revenue);
      const totalRevenue = withRevenue.reduce((acc, r) => acc + r.revenue, 0);

      let cumulative = 0;
      const classified: ProductRow[] = withRevenue.map((r) => {
        cumulative += r.revenue;
        const share = totalRevenue > 0 ? cumulative / totalRevenue : 1;
        const abc: AbcKey = share <= 0.8 ? "A" : share <= 0.95 ? "B" : "C";
        const coverage = r.days_with_sales / WINDOW_DAYS;
        const xyz: XyzKey = coverage > 0.6 ? "X" : coverage >= 0.2 ? "Y" : "Z";
        return {
          id: r.product_ms_id,
          name: r.product_name,
          category: r.category ?? "Без категории",
          revenue: r.revenue,
          quantity: r.quantity,
          cost: r.cost,
          daysWithSales: r.days_with_sales,
          abc,
          xyz,
        };
      });

      if (seq !== loadSeq.current) return;
      setRows(classified);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setRows([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStores.join(",")]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Склад».</p>
      </div>
    );
  }

  function toggleAbc(v: string) {
    setAbcFilter((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }
  function toggleXyz(v: string) {
    setXyzFilter((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }
  function toggleCategory(v: string) {
    setCategoryFilter((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }

  const categoryOptions = [...new Set(rows.map((r) => r.category))]
    .sort((a, b) => a.localeCompare(b, "ru"))
    .map((c) => ({ value: c, label: c }));

  const filtered = rows.filter(
    (r) =>
      (abcFilter.length === 0 || abcFilter.includes(r.abc)) &&
      (xyzFilter.length === 0 || xyzFilter.includes(r.xyz)) &&
      (categoryFilter.length === 0 || categoryFilter.includes(r.category))
  );
  const totalFilteredRevenue = filtered.reduce((acc, r) => acc + r.revenue, 0);

  // The matrix reflects the category filter (so it stays relevant once
  // you've narrowed to one department) but never the ABC/XYZ filters
  // themselves — otherwise clicking a cell's own row/column would zero the
  // rest of the matrix out instead of letting you compare it to the others.
  const matrixSource = rows.filter((r) => categoryFilter.length === 0 || categoryFilter.includes(r.category));
  const matrix: Record<AbcKey, Record<XyzKey, { count: number; revenue: number }>> = {
    A: { X: { count: 0, revenue: 0 }, Y: { count: 0, revenue: 0 }, Z: { count: 0, revenue: 0 } },
    B: { X: { count: 0, revenue: 0 }, Y: { count: 0, revenue: 0 }, Z: { count: 0, revenue: 0 } },
    C: { X: { count: 0, revenue: 0 }, Y: { count: 0, revenue: 0 }, Z: { count: 0, revenue: 0 } },
  };
  for (const r of matrixSource) {
    matrix[r.abc][r.xyz].count += 1;
    matrix[r.abc][r.xyz].revenue += r.revenue;
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Склад</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">АВС/XYZ анализ</h1>
        <p className="text-sm text-muted max-w-2xl mt-1">
          АВС — доля в выручке: A — верхние 80&nbsp;%, B — 15&nbsp;%, C — 5&nbsp;%. XYZ — ровность
          спроса: доля дней с продажами. X — больше 60&nbsp;%, Y — от 20&nbsp;%, Z — реже. Расчёт за
          последние {WINDOW_DAYS} дней.
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

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted">Нет данных за последние {WINDOW_DAYS} дней.</div>
      ) : (
        <>
          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="overflow-x-auto">
              <div className="min-w-[560px] grid grid-cols-[80px_1fr_1fr_1fr] gap-2">
                <div />
                <div className="text-[13px] font-semibold text-muted">X — стабильно</div>
                <div className="text-[13px] font-semibold text-muted">Y — неровно</div>
                <div className="text-[13px] font-semibold text-muted">Z — редко</div>
                {ABC_OPTIONS.map((abcOpt) => (
                  <div key={abcOpt.value} className="contents">
                    <div className="flex items-center font-serif text-[18px] font-semibold">{abcOpt.value}</div>
                    {XYZ_OPTIONS.map((xyzOpt) => {
                      const cell = matrix[abcOpt.value as AbcKey][xyzOpt.value as XyzKey];
                      return (
                        <div key={xyzOpt.value} className="rounded-lg border border-borderSoft px-3 py-2.5 text-[13px]">
                          <div className="num">{cell.count} поз</div>
                          <div className="num text-muted">{money(cell.revenue)}</div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-end gap-4 flex-wrap">
            <MultiSelectFilter label="ABC" options={ABC_OPTIONS} selected={abcFilter} onToggle={toggleAbc} onClear={() => setAbcFilter([])} />
            <MultiSelectFilter label="XYZ" options={XYZ_OPTIONS} selected={xyzFilter} onToggle={toggleXyz} onClear={() => setXyzFilter([])} />
            <MultiSelectFilter
              label="Категория"
              options={categoryOptions}
              selected={categoryFilter}
              onToggle={toggleCategory}
              onClear={() => setCategoryFilter([])}
            />
          </div>

          <div className="text-sm text-muted">
            Выбрано {filtered.length.toLocaleString("ru-RU")} позиций · выручка {money(totalFilteredRevenue)}
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            {filtered.length === 0 ? (
              <div className="text-sm text-muted py-4">Нет позиций под выбранные фильтры.</div>
            ) : mobileLayout ? (
              <div className="flex flex-col gap-3">
                {filtered.map((r) => {
                  const marginPct = r.revenue !== 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0;
                  return (
                    <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px]">
                      <div className="font-semibold">{r.name}</div>
                      <div className="text-muted text-[12.5px]">{r.category}</div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted">ABC / XYZ</span>
                        <span className="num font-bold">
                          {r.abc} / {r.xyz}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted">Выручка</span>
                        <span className="num">{money(r.revenue)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted">Штук</span>
                        <span className="num">{r.quantity.toLocaleString("ru-RU")}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted">Дней</span>
                        <span className="num">{r.daysWithSales}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted">Маржа %</span>
                        <span className="num">{marginPct.toFixed(0)}%</span>
                      </div>
                      <div className="text-mutedLight text-[12.5px] mt-1">{DECISIONS[`${r.abc}${r.xyz}`]}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[1100px] grid grid-cols-[1.4fr_1fr_0.4fr_0.4fr_0.9fr_0.6fr_0.5fr_0.7fr_1.8fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                  <div>Товар</div>
                  <div>Категория</div>
                  <div>ABC</div>
                  <div>XYZ</div>
                  <div>Выручка</div>
                  <div>Штук</div>
                  <div>Дней</div>
                  <div>Маржа %</div>
                  <div>Решение</div>
                </div>
                {filtered.map((r) => {
                  const marginPct = r.revenue !== 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0;
                  return (
                    <div
                      key={r.id}
                      className="min-w-[1100px] grid grid-cols-[1.4fr_1fr_0.4fr_0.4fr_0.9fr_0.6fr_0.5fr_0.7fr_1.8fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
                    >
                      <div className="font-semibold">{r.name}</div>
                      <div className="text-muted">{r.category}</div>
                      <div className="num font-bold">{r.abc}</div>
                      <div className="num font-bold">{r.xyz}</div>
                      <div className="num">{money(r.revenue)}</div>
                      <div className="num">{r.quantity.toLocaleString("ru-RU")}</div>
                      <div className="num">{r.daysWithSales}</div>
                      <div className="num">{marginPct.toFixed(0)}%</div>
                      <div className="text-muted text-[12.5px]">{DECISIONS[`${r.abc}${r.xyz}`]}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
