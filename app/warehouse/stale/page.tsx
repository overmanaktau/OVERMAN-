"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useSiteVersion } from "@/components/SiteVersion";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { WAREHOUSES, warehousesForCities } from "@/lib/warehouses";

// Products currently in stock with zero recorded sales in this many days —
// computed from our own synced sales history (moysklad_product_sales_daily),
// not МойСклад's "оборачиваемость" metric, which measures days-of-supply at
// the recent sales pace and can stay low even for something that hasn't
// actually sold in months. Threshold matches the page's own title; not
// user-adjustable.
const STALE_DAYS = 60;

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

// Grouped by "артикул" — model+colour together, not by individual МойСклад
// product (see deriveArticle in lib/moysklad.ts: colour makes it a
// different model, only size folds into the same article). Click a row to
// see the sizes behind it.
type StaleRow = {
  id: string; // the article string
  name: string;
  stock: number;
  money: number; // at cost (себестоимость)
  saleValue: number; // at retail (цена продажи)
  daysSinceLastSale: number | null; // null = no recorded sale at all in our synced history
  imageUrl: string | null;
  imageFullHref: string | null;
};

type LightboxState = { fullHref: string | null; fallbackSrc: string | null; alt: string };

function Thumb({
  src,
  fullHref,
  alt,
  onOpen,
}: {
  src: string | null;
  fullHref: string | null;
  alt: string;
  onOpen: (state: LightboxState) => void;
}) {
  if (!src) return <div className="w-9 h-9 rounded-md bg-paper border border-borderSoft flex-none" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external МойСклад CDN, not worth next/image's domain config for a thumbnail
    <img
      src={src}
      alt={alt}
      onClick={(e) => {
        e.stopPropagation();
        onOpen({ fullHref, fallbackSrc: src, alt });
      }}
      className="w-9 h-9 rounded-md object-cover border border-borderSoft flex-none cursor-zoom-in"
    />
  );
}

// Fetches the full-resolution photo through our own proxy (the original
// needs our API token — see app/api/moysklad/image) and falls back to
// whatever thumbnail was already on screen if that fails or there's no
// full-res version at all.
function Lightbox({ state, onClose }: { state: LightboxState | null; onClose: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setBlobUrl(null);
    if (!state?.fullHref) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const res = await fetch(`/api/moysklad/image?href=${encodeURIComponent(state.fullHref!)}`, {
          headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
        });
        if (!res.ok) throw new Error("failed");
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setBlobUrl(objectUrl);
      } catch {
        // silently keep the fallback thumbnail already on screen
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [state?.fullHref]);

  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  if (!state) return null;
  const src = blobUrl ?? state.fallbackSrc;
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={onClose}>
      {loading && !blobUrl && <div className="text-white text-sm">Загрузка фото…</div>}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- blob: / external URL, not a static asset
        <img
          src={src}
          alt={state.alt}
          onClick={(e) => e.stopPropagation()}
          className="max-w-full max-h-full rounded-lg object-contain"
        />
      )}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 text-white text-2xl leading-none w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10"
      >
        ✕
      </button>
    </div>
  );
}

const SORT_OPTIONS: { value: "money" | "saleValue" | "stock" | "days"; label: string }[] = [
  { value: "money", label: "по деньгам (себестоимость)" },
  { value: "saleValue", label: "по цене продажи" },
  { value: "stock", label: "по остатку" },
  { value: "days", label: "по дням без продаж" },
];
type SortField = (typeof SORT_OPTIONS)[number]["value"];

// null (never sold at all) sorts as "more stale than any finite count" —
// treating it as +Infinity puts it first when sorting "days" descending,
// same place it'd land if we actually knew how long ago it last sold.
function sortRows(rows: StaleRow[], field: SortField): StaleRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (field === "days") return (b.daysSinceLastSale ?? Infinity) - (a.daysSinceLastSale ?? Infinity);
    return b[field] - a[field];
  });
  return sorted;
}

// Paginates past PostgREST's default row cap — this list alone can run into
// the thousands (every slow-moving SKU across the whole catalog).
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

type StaleRawRow = {
  article: string;
  stock: number;
  money: number;
  sale_value: number;
  days_since_last_sale: number | null;
  image_url: string | null;
  image_full_href: string | null;
};

function mapStaleRows(raw: StaleRawRow[]): StaleRow[] {
  return raw.map((r) => ({
    id: r.article,
    name: r.article,
    stock: r.stock,
    money: r.money,
    saleValue: r.sale_value,
    daysSinceLastSale: r.days_since_last_sale,
    imageUrl: r.image_url,
    imageFullHref: r.image_full_href,
  }));
}

// One row per underlying МойСклад product inside an article — colour is
// already baked into the article, so all that's left to vary is size.
type SkuRow = {
  id: string;
  name: string;
  stock: number;
  money: number;
  saleValue: number;
  daysSinceLastSale: number | null;
  imageUrl: string | null;
  imageFullHref: string | null;
};

function SizeBreakdown({
  loading,
  rows,
  openLightbox,
}: {
  loading: boolean;
  rows: SkuRow[] | undefined;
  openLightbox: (state: LightboxState) => void;
}) {
  if (loading) return <div className="text-[12.5px] text-muted py-2 pl-11">Загрузка размеров…</div>;
  if (!rows || rows.length === 0) return <div className="text-[12.5px] text-mutedLight py-2 pl-11">Нет данных по размерам.</div>;
  return (
    <div className="flex flex-col gap-1.5 py-2 pl-11 pr-2">
      {rows.map((s) => (
        <div key={s.id} className="flex items-center gap-2.5 text-[12.5px]">
          <Thumb src={s.imageUrl} fullHref={s.imageFullHref} alt={s.name} onOpen={openLightbox} />
          <div className="flex-1 min-w-0 break-words text-muted">{s.name}</div>
          <div className="num flex-none">{s.stock.toLocaleString("ru-RU")} шт</div>
          <div className="num text-mutedLight flex-none w-24 text-right">{money(s.money)}</div>
          <div className="num text-mutedLight flex-none w-20 text-right">
            {s.daysSinceLastSale === null ? "не продавался" : `${s.daysSinceLastSale} дн.`}
          </div>
        </div>
      ))}
    </div>
  );
}

function StaleTable({
  rows,
  mobileLayout,
  emptyText,
  staleDays,
  stores,
  openLightbox,
}: {
  rows: StaleRow[];
  mobileLayout: boolean;
  emptyText: string;
  staleDays: number;
  stores: string[];
  openLightbox: (state: LightboxState) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [skuCache, setSkuCache] = useState<Record<string, SkuRow[]>>({});
  const [skuLoading, setSkuLoading] = useState<Set<string>>(new Set());

  async function toggleExpand(articleId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
    if (skuCache[articleId]) return;
    setSkuLoading((prev) => new Set(prev).add(articleId));
    try {
      const skuRaw = await fetchAllRows<{
        product_ms_id: string;
        product_name: string;
        stock: number;
        money: number;
        sale_value: number;
        days_since_last_sale: number | null;
        image_url: string | null;
        image_full_href: string | null;
      }>((from_, to_) =>
        supabase
          .rpc("stale_inventory_by_sku", { p_stale_days: staleDays, p_stores: stores, p_article: articleId })
          .range(from_, to_)
      );
      skuRaw.sort((a, b) => b.stock - a.stock);
      setSkuCache((prev) => ({
        ...prev,
        [articleId]: skuRaw.map((s) => ({
          id: s.product_ms_id,
          name: s.product_name,
          stock: s.stock,
          money: s.money,
          saleValue: s.sale_value,
          daysSinceLastSale: s.days_since_last_sale,
          imageUrl: s.image_url,
          imageFullHref: s.image_full_href,
        })),
      }));
    } catch {
      setSkuCache((prev) => ({ ...prev, [articleId]: [] }));
    } finally {
      setSkuLoading((prev) => {
        const next = new Set(prev);
        next.delete(articleId);
        return next;
      });
    }
  }

  if (rows.length === 0) return <div className="text-sm text-muted py-4">{emptyText}</div>;
  if (mobileLayout) {
    return (
      <div className="flex flex-col gap-3">
        {rows.map((r) => {
          const isOpen = expanded.has(r.id);
          return (
            <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px]">
              <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => toggleExpand(r.id)} title="Показать размеры">
                <span className="text-mutedLight text-[10px] w-3 flex-none">{isOpen ? "▾" : "▸"}</span>
                <Thumb src={r.imageUrl} fullHref={r.imageFullHref} alt={r.name} onOpen={openLightbox} />
                <div className="font-semibold break-words">{r.name}</div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Остаток</span>
                <span className="num">{r.stock.toLocaleString("ru-RU")}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Деньги (себестоимость)</span>
                <span className="num">{money(r.money)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">По цене продажи</span>
                <span className="num">{money(r.saleValue)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Без продаж</span>
                <span className="num">{r.daysSinceLastSale === null ? "не продавался" : `${r.daysSinceLastSale} дн.`}</span>
              </div>
              {isOpen && (
                <div className="border-t border-borderSoft mt-1">
                  <SizeBreakdown loading={skuLoading.has(r.id)} rows={skuCache[r.id]} openLightbox={openLightbox} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px] grid grid-cols-[1.6fr_0.6fr_0.9fr_0.9fr_1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
        <div>Артикул</div>
        <div>Остаток</div>
        <div>Деньги (себест.)</div>
        <div>По цене продажи</div>
        <div>Без продаж</div>
      </div>
      {rows.map((r) => {
        const isOpen = expanded.has(r.id);
        return (
          <div key={r.id} className="min-w-[800px] border-b border-borderSoft">
            <div
              className="grid grid-cols-[1.6fr_0.6fr_0.9fr_0.9fr_1fr] gap-3 py-2.5 items-center text-[13px] cursor-pointer"
              onClick={() => toggleExpand(r.id)}
              title="Показать размеры"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-mutedLight text-[10px] w-3 flex-none">{isOpen ? "▾" : "▸"}</span>
                <Thumb src={r.imageUrl} fullHref={r.imageFullHref} alt={r.name} onOpen={openLightbox} />
                <div className="font-semibold break-words">{r.name}</div>
              </div>
              <div className="num">{r.stock.toLocaleString("ru-RU")}</div>
              <div className="num">{money(r.money)}</div>
              <div className="num text-muted">{money(r.saleValue)}</div>
              <div className="num text-muted">{r.daysSinceLastSale === null ? "не продавался" : `${r.daysSinceLastSale} дн.`}</div>
            </div>
            {isOpen && <SizeBreakdown loading={skuLoading.has(r.id)} rows={skuCache[r.id]} openLightbox={openLightbox} />}
          </div>
        );
      })}
    </div>
  );
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
              <span className="text-mutedLight">Все склады</span>
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
              <label key={o.value} className="flex items-center gap-2 text-[13px] py-1.5 px-1.5 rounded-md hover:bg-paper cursor-pointer">
                <input type="checkbox" checked={selected.includes(o.value)} onChange={() => onToggle(o.value)} className="accent-accent" />
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

export default function StaleInventoryPage() {
  const { isAdmin, permissions, accessibleStoreCodes } = useAuth();
  const { mobileLayout } = useSiteVersion();
  const canView = isAdmin || permissions["warehouse.stock"].canView;

  // Independent of the city picker in the sidebar — that one drives every
  // other page; this page filters by real склад (not city) on its own, so
  // it can be narrowed here without touching the global selection.
  const accessibleWarehouseCodes = warehousesForCities(accessibleStoreCodes);
  const [storeFilter, setStoreFilter] = useState<string[]>([]);
  const effectiveStores = storeFilter.length > 0 ? storeFilter : accessibleWarehouseCodes;
  const storeOptions = WAREHOUSES.filter((w) => accessibleWarehouseCodes.includes(w.code)).map((w) => ({ value: w.code, label: w.label }));
  function toggleStore(code: string) {
    setStoreFilter((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<StaleRow[]>([]);
  // "Заморозка" (written-off-for-now stock, held back for next season) is
  // its own bucket the business tracks on purpose — always shown, never
  // folded into the store-filtered list above.
  const [frozenRows, setFrozenRows] = useState<StaleRow[]>([]);
  const [sortField, setSortField] = useState<SortField>("money");
  function cycleSortField() {
    const idx = SORT_OPTIONS.findIndex((o) => o.value === sortField);
    setSortField(SORT_OPTIONS[(idx + 1) % SORT_OPTIONS.length].value);
  }
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [raw, rawFrozen] = await Promise.all([
        fetchAllRows<StaleRawRow>((from, to) =>
          supabase.rpc("stale_inventory", { p_stale_days: STALE_DAYS, p_stores: effectiveStores }).order("article", { ascending: true }).range(from, to)
        ),
        // -1 rather than STALE_DAYS: "заморозка" isn't about staleness, it's
        // stock the business deliberately set aside — show all of it, not
        // just what's also been sitting 60+ days. (current_date - last_sale)
        // is never negative, so "> -1" always passes.
        fetchAllRows<StaleRawRow>((from, to) =>
          supabase.rpc("stale_inventory", { p_stale_days: -1, p_stores: ["frozen"] }).order("article", { ascending: true }).range(from, to)
        ),
      ]);

      if (seq !== loadSeq.current) return;
      setRows(mapStaleRows(raw));
      setFrozenRows(mapStaleRows(rawFrozen));
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setRows([]);
      setFrozenRows([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStores.join(",")]);

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

  const totalMoney = rows.reduce((acc, r) => acc + r.money, 0);
  const totalSaleValue = rows.reduce((acc, r) => acc + r.saleValue, 0);
  const totalFrozenMoney = frozenRows.reduce((acc, r) => acc + r.money, 0);
  const totalFrozenSaleValue = frozenRows.reduce((acc, r) => acc + r.saleValue, 0);

  return (
    <>
      <Lightbox state={lightbox} onClose={() => setLightbox(null)} />
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Склад</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Зависшие остатки</h1>
        <p className="text-sm text-muted max-w-2xl mt-1">
          Товары в наличии, которые не продавались {STALE_DAYS}+ дней (или ни разу за всё время синхронизации). По
          артикулу — модель и цвет вместе; нажмите на строку, чтобы раскрыть размеры внутри неё.
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

      {storeOptions.length > 1 && (
        <MultiSelectFilter label="Склад" options={storeOptions} selected={storeFilter} onToggle={toggleStore} onClear={() => setStoreFilter([])} />
      )}

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Зависло дольше {STALE_DAYS} дней</div>
              <div className="font-serif text-[26px] font-semibold num">{rows.length.toLocaleString("ru-RU")} артикулов</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Денег в них (себестоимость)</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalMoney)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">По цене продажи</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalSaleValue)}</div>
            </div>
          </div>

          <button
            type="button"
            onClick={cycleSortField}
            className="self-start text-[13px] font-semibold text-accent bg-surface border border-border rounded-md px-3.5 py-2 hover:bg-paper"
          >
            Сортировка: {SORT_OPTIONS.find((o) => o.value === sortField)?.label}
          </button>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <StaleTable
              rows={sortRows(rows, sortField)}
              mobileLayout={mobileLayout}
              emptyText="Нет зависших остатков — всё продаётся вовремя."
              staleDays={STALE_DAYS}
              stores={effectiveStores}
              openLightbox={setLightbox}
            />
          </div>

          <div className="flex flex-col gap-1 mt-2">
            <h2 className="font-serif text-[20px] font-semibold m-0">Заморозка</h2>
            <p className="text-sm text-muted max-w-2xl">Товар на складах заморозки — отдельно от городов, ждёт следующего сезона.</p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Артикулов в заморозке</div>
              <div className="font-serif text-[26px] font-semibold num">{frozenRows.length.toLocaleString("ru-RU")}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Денег в них (себестоимость)</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalFrozenMoney)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">По цене продажи</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalFrozenSaleValue)}</div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <StaleTable
              rows={sortRows(frozenRows, sortField)}
              mobileLayout={mobileLayout}
              emptyText="В заморозке ничего нет."
              staleDays={-1}
              stores={["frozen"]}
              openLightbox={setLightbox}
            />
          </div>
        </>
      )}
    </>
  );
}
