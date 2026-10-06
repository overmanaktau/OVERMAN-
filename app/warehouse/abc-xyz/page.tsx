"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { useSiteVersion } from "@/components/SiteVersion";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { WAREHOUSES, warehousesForCities } from "@/lib/warehouses";

const PERIODS = ["Вчера", "Прошлая неделя", "Эта неделя", "С начала месяца", "Прошлый месяц", "Всё время"];
const DEFAULT_PERIOD = 5; // "Всё время"

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
const XYZ_LABELS: { key: XyzKey; label: string }[] = [
  { key: "X", label: "X — стабильно" },
  { key: "Y", label: "Y — неровно" },
  { key: "Z", label: "Z — редко" },
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
  if (index === 3) return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: d }; // С начала месяца
  if (index === 4) {
    return { start: new Date(d.getFullYear(), d.getMonth() - 1, 1), end: new Date(d.getFullYear(), d.getMonth(), 0) };
  }
  return { start: new Date(2000, 0, 1), end: d }; // Всё время
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

// Grouped by "артикул" — model+colour together, not by individual МойСклад
// product — this account has no working article field, so every colour and
// size is its own product; classifying at that grain made XYZ meaningless (a
// single size in one colour almost never sells daily). Colour is kept as
// part of the article (a different colour is a different model, per the
// business); only size gets folded in. See deriveArticle in lib/moysklad.ts.
type ProductRow = {
  id: string; // the derived article string, doubles as the row key
  name: string;
  category: string;
  revenue: number;
  quantity: number;
  cost: number;
  daysWithSales: number;
  abc: AbcKey;
  xyz: XyzKey;
  imageUrl: string | null; // one photo per article — whichever size/colour SKU in the group happens to have one
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
        <img src={src} alt={state.alt} onClick={(e) => e.stopPropagation()} className="max-w-full max-h-full rounded-lg object-contain" />
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

// One row per underlying МойСклад product inside an article — since colour
// is now baked into the article itself, all that's left to vary between
// these is size (see deriveArticle in lib/moysklad.ts).
type SkuRow = {
  id: string;
  name: string;
  revenue: number;
  quantity: number;
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
  if (loading) return <div className="text-[12.5px] text-muted py-2 pl-3 sm:pl-11">Загрузка размеров…</div>;
  if (!rows || rows.length === 0) return <div className="text-[12.5px] text-mutedLight py-2 pl-3 sm:pl-11">Нет данных по размерам.</div>;
  return (
    <div className="flex flex-col gap-2 py-2 pl-3 sm:pl-11 pr-2">
      {rows.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px]">
          <Thumb src={s.imageUrl} fullHref={s.imageFullHref} alt={s.name} onOpen={openLightbox} />
          <div className="flex-1 basis-[150px] min-w-[150px] break-words text-muted">{s.name}</div>
          <div className="flex items-center gap-3 flex-none ml-auto">
            <div className="num">{s.quantity.toLocaleString("ru-RU")} шт</div>
            <div className="num text-mutedLight text-right">{money(s.revenue)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

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
  const { isAdmin, permissions, accessibleStoreCodes } = useAuth();
  const { mobileLayout } = useSiteVersion();
  const canView = isAdmin || permissions["warehouse.stock"].canView;

  // Independent of the city picker in the sidebar — that one drives every
  // other page; this page filters by real склад (not city) on its own.
  const accessibleWarehouseCodes = warehousesForCities(accessibleStoreCodes);
  const [storeFilter, setStoreFilter] = useState<string[]>([]);
  const effectiveStores = storeFilter.length > 0 ? storeFilter : accessibleWarehouseCodes;
  const storeOptions = WAREHOUSES.filter((w) => accessibleWarehouseCodes.includes(w.code)).map((w) => ({ value: w.code, label: w.label }));
  function toggleStore(code: string) {
    setStoreFilter((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  const [periodIndex, setPeriodIndex] = useState(DEFAULT_PERIOD);
  const [activeCustom, setActiveCustom] = useState<{ start: string; end: string } | null>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customPickerRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [windowDays, setWindowDays] = useState(1);
  const [abcFilter, setAbcFilter] = useState<string[]>([]);
  const [xyzFilter, setXyzFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  // The date range from the last successful load — reused when expanding a
  // row's size breakdown so it always matches what's currently on screen.
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [skuCache, setSkuCache] = useState<Record<string, SkuRow[]>>({});
  const [skuLoading, setSkuLoading] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const range = activeCustom
        ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
        : getPeriodRange(periodIndex, new Date());
      const from = ymd(range.start);
      const to = ymd(range.end);
      // "Всё время" spans from year 2000 so it never misses data, but that
      // makes a terrible XYZ denominator — a product that sold on every
      // single day we've actually synced would still show ~1% coverage
      // (days_with_sales / ~9500), landing everything in Z. Clamp the
      // denominator to when our own data actually starts.
      const { data: earliestRow } = await supabase
        .from("moysklad_product_sales_daily")
        .select("sale_date")
        .order("sale_date", { ascending: true })
        .limit(1)
        .maybeSingle();
      const effectiveStart = earliestRow?.sale_date
        ? new Date(Math.max(parseYmd(earliestRow.sale_date).getTime(), range.start.getTime()))
        : range.start;
      const days = Math.max(1, Math.round((range.end.getTime() - effectiveStart.getTime()) / 86400000) + 1);
      type Raw = {
        article: string;
        category: string | null;
        revenue: number;
        quantity: number;
        cost: number;
        days_with_sales: number;
        image_url: string | null;
        image_full_href: string | null;
      };
      const raw = await fetchAllRows<Raw>((from_, to_) =>
        supabase.rpc("product_sales_summary_by_article", { p_from: from, p_to: to, p_stores: effectiveStores }).range(from_, to_)
      );

      // Only articles with real net revenue in the window get classified —
      // one with zero (or return-only) sales here has nothing to rank by
      // ABC and belongs to the separate "Зависшие остатки" page instead.
      const withRevenue = raw.filter((r) => r.revenue > 0);
      withRevenue.sort((a, b) => b.revenue - a.revenue);
      const totalRevenue = withRevenue.reduce((acc, r) => acc + r.revenue, 0);

      let cumulative = 0;
      const classified: ProductRow[] = withRevenue.map((r) => {
        cumulative += r.revenue;
        const share = totalRevenue > 0 ? cumulative / totalRevenue : 1;
        const abc: AbcKey = share <= 0.8 ? "A" : share <= 0.95 ? "B" : "C";
        const coverage = r.days_with_sales / days;
        const xyz: XyzKey = coverage > 0.6 ? "X" : coverage >= 0.2 ? "Y" : "Z";
        return {
          id: r.article,
          name: r.article,
          category: r.category ?? "Без категории",
          revenue: r.revenue,
          quantity: r.quantity,
          cost: r.cost,
          daysWithSales: r.days_with_sales,
          abc,
          xyz,
          imageUrl: r.image_url,
          imageFullHref: r.image_full_href,
        };
      });

      if (seq !== loadSeq.current) return;
      setRows(classified);
      setWindowDays(days);
      setRange({ from, to });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(friendlyError(e));
      setRows([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodIndex, activeCustom?.start, activeCustom?.end, effectiveStores.join(",")]);

  useEffect(() => {
    load();
    // A new period/store selection invalidates any cached size breakdowns —
    // they were fetched for the old range and would show stale numbers.
    setExpanded(new Set());
    setSkuCache({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function toggleExpand(articleId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
    if (skuCache[articleId] || !range.from) return;
    setSkuLoading((prev) => new Set(prev).add(articleId));
    try {
      const skuRaw = await fetchAllRows<{
        product_ms_id: string;
        product_name: string;
        revenue: number;
        quantity: number;
        image_url: string | null;
        image_full_href: string | null;
      }>((from_, to_) =>
        supabase
          .rpc("product_sales_summary_by_sku", {
            p_from: range.from,
            p_to: range.to,
            p_stores: effectiveStores,
            p_article: articleId,
          })
          .range(from_, to_)
      );
      skuRaw.sort((a, b) => b.quantity - a.quantity);
      setSkuCache((prev) => ({
        ...prev,
        [articleId]: skuRaw.map((s) => ({
          id: s.product_ms_id,
          name: s.product_name,
          revenue: s.revenue,
          quantity: s.quantity,
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

  useEffect(() => {
    if (!showCustomPicker) return;
    function onClick(e: MouseEvent) {
      if (customPickerRef.current && !customPickerRef.current.contains(e.target as Node)) setShowCustomPicker(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showCustomPicker]);

  function applyCustomRange() {
    if (!customStart || !customEnd || customStart > customEnd) return;
    setActiveCustom({ start: customStart, end: customEnd });
    setShowCustomPicker(false);
  }

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
      (categoryFilter.length === 0 || categoryFilter.includes(r.category)) &&
      (!search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()))
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
      <Lightbox state={lightbox} onClose={() => setLightbox(null)} />
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Склад</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">АВС/XYZ анализ</h1>
        <p className="text-sm text-muted max-w-2xl mt-1">
          АВС — доля в выручке: A — верхние 80&nbsp;%, B — 15&nbsp;%, C — 5&nbsp;%. XYZ — ровность
          спроса: доля дней с продажами за выбранный период. X — больше 60&nbsp;%, Y — от 20&nbsp;%,
          Z — реже. По артикулу — это модель и цвет вместе (разный цвет = другая модель); нажмите на
          строку, чтобы раскрыть размеры внутри неё.
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

      {storeOptions.length > 1 && (
        <div className="max-w-[240px]">
          <MultiSelectFilter label="Склад" options={storeOptions} selected={storeFilter} onToggle={toggleStore} onClear={() => setStoreFilter([])} />
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted">Нет данных за выбранный период.</div>
      ) : (
        <>
          <div className="text-xs text-mutedLight">
            Дней в периоде: {windowDays} — от этого зависит, что считается «стабильным» спросом в XYZ.
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            {/* Mobile: one card per ABC row, X/Y/Z stacked as labeled lines —
                no horizontal scroll anywhere, the side-by-side grid below
                just doesn't fit a phone width. */}
            <div className="flex flex-col gap-3 sm:hidden">
              {ABC_OPTIONS.map((abcOpt) => (
                <div key={abcOpt.value} className="rounded-lg border border-borderSoft p-3 flex flex-col gap-2">
                  <div className="font-serif text-[18px] font-semibold">{abcOpt.value}</div>
                  {XYZ_LABELS.map(({ key, label }) => {
                    const cell = matrix[abcOpt.value as AbcKey][key];
                    return (
                      <div key={key} className="flex items-center justify-between text-[13px]">
                        <span className="text-muted">{label}</span>
                        <span className="text-right">
                          <span className="num">{cell.count} поз</span> · <span className="num text-muted">{money(cell.revenue)}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="hidden sm:block overflow-x-auto">
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
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted">Поиск</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Название товара…"
                className="bg-paper border border-border rounded-lg px-3 py-2 text-[13px] w-[220px]"
              />
            </label>
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
                  const isOpen = expanded.has(r.id);
                  return (
                    <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-borderSoft p-3 text-[13px]">
                      <div
                        className="flex items-center gap-2.5 cursor-pointer"
                        onClick={() => toggleExpand(r.id)}
                        title="Показать размеры"
                      >
                        <span className="text-mutedLight text-[10px] w-3 flex-none">{isOpen ? "▾" : "▸"}</span>
                        <Thumb src={r.imageUrl} fullHref={r.imageFullHref} alt={r.name} onOpen={setLightbox} />
                        <div className="font-semibold break-words">{r.name}</div>
                      </div>
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
                      {isOpen && (
                        <div className="border-t border-borderSoft mt-1">
                          <SizeBreakdown loading={skuLoading.has(r.id)} rows={skuCache[r.id]} openLightbox={setLightbox} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[1100px] grid grid-cols-[1.4fr_1fr_0.4fr_0.4fr_0.9fr_0.6fr_0.5fr_0.7fr_1.8fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                  <div>Артикул</div>
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
                  const isOpen = expanded.has(r.id);
                  return (
                    <div key={r.id} className="min-w-[1100px] border-b border-borderSoft">
                      <div
                        className="grid grid-cols-[1.4fr_1fr_0.4fr_0.4fr_0.9fr_0.6fr_0.5fr_0.7fr_1.8fr] gap-3 py-2.5 items-center text-[13px] cursor-pointer"
                        onClick={() => toggleExpand(r.id)}
                        title="Показать размеры"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="text-mutedLight text-[10px] w-3 flex-none">{isOpen ? "▾" : "▸"}</span>
                          <Thumb src={r.imageUrl} fullHref={r.imageFullHref} alt={r.name} onOpen={setLightbox} />
                          <div className="font-semibold break-words">{r.name}</div>
                        </div>
                        <div className="text-muted">{r.category}</div>
                        <div className="num font-bold">{r.abc}</div>
                        <div className="num font-bold">{r.xyz}</div>
                        <div className="num">{money(r.revenue)}</div>
                        <div className="num">{r.quantity.toLocaleString("ru-RU")}</div>
                        <div className="num">{r.daysWithSales}</div>
                        <div className="num">{marginPct.toFixed(0)}%</div>
                        <div className="text-muted text-[12.5px]">{DECISIONS[`${r.abc}${r.xyz}`]}</div>
                      </div>
                      {isOpen && <SizeBreakdown loading={skuLoading.has(r.id)} rows={skuCache[r.id]} openLightbox={setLightbox} />}
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
