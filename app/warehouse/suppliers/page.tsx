"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { downloadExcel } from "@/lib/exportExcel";
import { WAREHOUSES, warehousesForCities } from "@/lib/warehouses";
import { useStockedWarehouses } from "@/lib/useStockedWarehouses";
import PdfButton from "@/components/PdfButton";
import type { PdfDoc } from "@/lib/downloadPdf";

// Склад → «По поставщикам». Поставщик — из карточки товара в МойСклад.
// Вкладка «Остатки»: что сейчас лежит у каждого поставщика (штуки и себестоимость).
// Вкладка «Зависшие остатки»: то же правило, что на странице «Зависшие остатки»
// (не продавалось и не приходило дольше STALE_DAYS), но в разрезе поставщиков.
const STALE_DAYS = 45;
const STALE_DAYS_QUERY = STALE_DAYS - 1; // SQL сравнивает строго «>»

function money(n: number) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₸`;
}
function num(n: number) {
  return Math.round(n).toLocaleString("ru-RU");
}
function pct(part: number, total: number) {
  return total > 0 ? `${((part / total) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%` : "—";
}

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const pageSize = 1000;
  let offset = 0;
  const all: T[] = [];
  for (;;) {
    const { data, error } = await build(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

type Tab = "stock" | "stale";

type SupplierRow = {
  supplier: string;
  skus: number;
  articles: number;
  stock: number;
  money: number;
  saleValue: number;
  maxDays: number | null;
};

type ItemRow = {
  id: string;
  name: string;
  article: string;
  stock: number;
  money: number;
  saleValue: number;
  buyPrice: number | null;
  days: number | null;
};

type ArticleGroup = { article: string; stock: number; money: number; saleValue: number; maxDays: number | null; items: ItemRow[] };

function groupByArticle(items: ItemRow[]): ArticleGroup[] {
  const map = new Map<string, ArticleGroup>();
  for (const it of items) {
    const g = map.get(it.article) ?? { article: it.article, stock: 0, money: 0, saleValue: 0, maxDays: null, items: [] };
    g.stock += it.stock;
    g.money += it.money;
    g.saleValue += it.saleValue;
    if (it.days !== null && (g.maxDays === null || it.days > g.maxDays)) g.maxDays = it.days;
    g.items.push(it);
    map.set(it.article, g);
  }
  return [...map.values()].sort((a, b) => b.money - a.money);
}

function Chevron({ open }: { open: boolean }) {
  return <span className="text-mutedLight text-[10px] w-3 flex-none inline-block">{open ? "▾" : "▸"}</span>;
}

// ── Приёмки поставщика: каждый приход по датам и документам и сколько из него продано.
// Продажи списываются с самого старого прихода (FIFO), поэтому остаток товара
// считается «с конца»: в самых свежих приходах. Учитываются только документы «Приёмка».
type ReceiptLine = {
  supplyId: string;
  docName: string;
  date: string;
  store: string;
  lineNo: number;
  productId: string;
  productName: string;
  quantity: number;
  price: number | null;
  remaining: number;
};
type ReceiptDoc = { supplyId: string; docName: string; date: string; store: string; lines: ReceiptLine[] };

const DOCS_PAGE = 25;

function fmtRuDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function daysSince(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const then = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((today - then) / 86400000));
}

// приёмки одного поставщика не меняются, пока открыта страница, — повторно не грузим
const receiptsCache = new Map<string, ReceiptLine[]>();

// productIds — показать приходы только этих товаров (кнопка «Приёмки» у товара или размера);
// без него — все приходы поставщика
function ReceiptsPanel({ supplier, stores, productIds, title }: { supplier: string; stores: string[]; productIds?: string[]; title?: string }) {
  const [lines, setLines] = useState<ReceiptLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openDocs, setOpenDocs] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(!!productIds);
  const [shown, setShown] = useState(DOCS_PAGE);
  const storesKey = stores.join(",");
  const productKey = productIds ? productIds.join(",") : "";

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `${supplier}|${storesKey}`;
    const cached = receiptsCache.get(cacheKey);
    setError(null);
    if (cached) {
      setLines(cached);
      return;
    }
    setLines(null);
    (async () => {
      try {
        type Raw = {
          supply_id: string;
          doc_name: string | null;
          doc_date: string;
          store: string;
          line_no: number;
          product_ms_id: string;
          product_name: string;
          quantity: number;
          price: number | null;
          remaining: number;
        };
        const raw = await fetchAllRows<Raw>((from, to) => supabase.rpc("supplier_receipts", { p_supplier: supplier, p_stores: stores }).range(from, to));
        if (cancelled) return;
        const mapped = raw.map((r) => ({
            supplyId: r.supply_id,
            docName: r.doc_name ?? "",
            date: r.doc_date,
            store: r.store,
            lineNo: r.line_no,
            productId: r.product_ms_id,
            productName: r.product_name,
            quantity: Number(r.quantity),
            price: r.price != null ? Number(r.price) : null,
            remaining: Number(r.remaining),
          }));
        receiptsCache.set(cacheKey, mapped);
        setLines(mapped);
      } catch (e) {
        if (!cancelled) setError(getErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplier, storesKey]);

  const q = query.trim().toLowerCase();
  const docs = useMemo(() => {
    if (!lines) return [];
    const map = new Map<string, ReceiptDoc>();
    const only = productIds ? new Set(productIds) : null;
    for (const l of lines) {
      if (only && !only.has(l.productId)) continue;
      if (q && !l.productName.toLowerCase().includes(q)) continue;
      const d = map.get(l.supplyId) ?? { supplyId: l.supplyId, docName: l.docName, date: l.date, store: l.store, lines: [] };
      d.lines.push(l);
      map.set(l.supplyId, d);
    }
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date) || b.docName.localeCompare(a.docName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, q, productKey]);

  const warehouseLabel = (code: string) => WAREHOUSES.find((w) => w.code === code)?.label ?? (code === "frozen" ? "Заморозка" : code);
  const grid = "grid-cols-[0.8fr_1.1fr_1fr_0.7fr_1fr_0.7fr_0.7fr_1fr_0.8fr_0.7fr]";

  function toggleDoc(id: string) {
    setOpenDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sumOf = (ls: ReceiptLine[]) => {
    const qty = ls.reduce((a, l) => a + l.quantity, 0);
    const remaining = ls.reduce((a, l) => a + l.remaining, 0);
    const cost = ls.reduce((a, l) => a + l.quantity * (l.price ?? 0), 0);
    return { qty, remaining, sold: qty - remaining, cost };
  };

  function Cells({ qty, cost, sold, remaining, date }: { qty: number; cost: number; sold: number; remaining: number; date: string }) {
    const days = daysSince(date);
    return (
      <>
        <div className="num text-right">{num(qty)}</div>
        <div className="num text-right">{money(cost)}</div>
        <div className="num text-right">{num(sold)}</div>
        <div className="num text-right">{num(remaining)}</div>
        <div className="flex items-center justify-end gap-2">
          <div className="w-14 h-1.5 bg-paper rounded-full overflow-hidden flex-none">
            <div className="h-full bg-accent rounded-full" style={{ width: `${qty > 0 ? Math.min(100, (sold / qty) * 100) : 0}%` }} />
          </div>
          <span className="num w-10 text-right">{qty > 0 ? `${Math.round((sold / qty) * 100)}%` : "—"}</span>
        </div>
        <div className="num text-right text-muted">{sold > 0 ? (sold / Math.max(1, days)).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "0"}</div>
        <div className="num text-right text-muted">{days} дн.</div>
      </>
    );
  }

  return (
    <div className="bg-paper/40 border-t border-borderSoft px-3 py-3 min-w-[980px]">
      <div className="flex items-center gap-3 flex-wrap mb-2.5 pl-6">
        <div className="text-[13px] font-bold">{title ? `Приёмки: ${title}` : `Приёмки поставщика ${supplier}`}</div>
        {!productIds && (
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти товар…"
            className="bg-paper border border-border rounded-lg px-3 py-1.5 text-[12.5px] w-[200px]"
          />
        )}
        <button
          type="button"
          onClick={() => {
            setAllOpen((v) => !v);
            setOpenDocs(new Set());
          }}
          disabled={docs.length === 0}
          className="text-[12px] font-semibold text-accent bg-surface border border-border rounded-md px-3 py-1.5 hover:bg-paper disabled:opacity-50"
        >
          {allOpen ? "Свернуть все приходы" : "Раскрыть все приходы"}
        </button>
        <PdfButton
          label="Скачать PDF"
          disabled={docs.length === 0}
          className="text-[12px] font-semibold text-accent bg-surface border border-border rounded-md px-3 py-1.5 hover:bg-paper disabled:opacity-50"
          build={(): PdfDoc => {
            const all = sumOf(docs.flatMap((d) => d.lines));
            const rowsOut: (string | number)[][] = [];
            const kinds: ("group" | "sub")[] = [];
            const indent: number[] = [];
            for (const d of docs) {
              const t = sumOf(d.lines);
              const days = daysSince(d.date);
              rowsOut.push([fmtRuDate(d.date), d.docName || "—", warehouseLabel(d.store), num(t.qty), money(t.cost), num(t.sold), num(t.remaining), t.qty > 0 ? `${Math.round((t.sold / t.qty) * 100)}%` : "—", t.sold > 0 ? (t.sold / Math.max(1, days)).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "0", `${days} дн.`]);
              kinds.push("group");
              indent.push(0);
              for (const l of [...d.lines].sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName, "ru"))) {
                const sold = l.quantity - l.remaining;
                rowsOut.push([l.productName + (l.price !== null ? ` · ${money(l.price)}/шт` : ""), "", "", num(l.quantity), money(l.quantity * (l.price ?? 0)), num(sold), num(l.remaining), l.quantity > 0 ? `${Math.round((sold / l.quantity) * 100)}%` : "—", sold > 0 ? (sold / Math.max(1, days)).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "0", ""]);
                kinds.push("sub");
                indent.push(1);
              }
            }
            return {
              fileName: title ? `Приёмки_${title}` : `Приёмки_${supplier}`,
              title: title ? `Приёмки: ${title}` : `Приёмки поставщика ${supplier}`,
              subtitle: `${title ? `Поставщик ${supplier} · ` : ""}${stores.map(warehouseLabel).join(", ")}${q ? ` · товар: «${query.trim()}»` : ""}`,
              meta: ["Продажи списываются с самого старого прихода (FIFO).", "Учтены только документы «Приёмка»."],
              orientation: "landscape",
              kpis: [
                { label: "Приходов", value: String(docs.length) },
                { label: "Принято, шт", value: num(all.qty) },
                { label: "Себестоимость", value: money(all.cost) },
                { label: "Продано", value: all.qty > 0 ? `${Math.round((all.sold / all.qty) * 100)}%` : "—", note: `${num(all.sold)} из ${num(all.qty)} шт` },
              ],
              sections: [
                {
                  headers: ["Дата / товар", "Документ", "Склад", "Принято, шт", "Себестоимость", "Продано", "Остаток", "Продано, %", "В день", "С прихода"],
                  levelLabels: ["Только приходы", "+ товары в приходах"],
                  rows: rowsOut,
                  rowKinds: kinds,
                  indent,
                  align: ["left", "left", "left", "right", "right", "right", "right", "right", "right", "right"],
                  widths: [3.2, 1.2, 1.5, 1, 1.5, 0.9, 0.9, 1, 0.8, 1],
                },
              ],
            };
          }}
        />
        <div className="text-[11.5px] text-mutedLight max-w-xl">
          Продажи списываются с самого старого прихода. «В день» — продано ÷ дней с прихода. Только документы «Приёмка» (перемещения и оприходования не видны).
        </div>
      </div>

      {error && <div className="text-[12.5px] text-[#A34B36] pl-6">{error}</div>}
      {!lines && !error && <div className="text-[12.5px] text-muted pl-6 py-2">Загрузка приёмок…</div>}
      {lines && docs.length === 0 && <div className="text-[12.5px] text-mutedLight pl-6 py-2">{q ? "Ничего не найдено." : "Приёмок нет."}</div>}

      {docs.length > 0 && (
        <>
          <div className={`grid ${grid} gap-3 pb-2 pl-6 text-[10px] uppercase tracking-wide text-mutedLight border-b border-border`}>
            <div>Дата</div>
            <div>Документ</div>
            <div>Склад</div>
            <div className="text-right">Принято, шт</div>
            <div className="text-right">Себестоимость</div>
            <div className="text-right">Продано</div>
            <div className="text-right">Остаток</div>
            <div className="text-right">Продано, %</div>
            <div className="text-right">В день</div>
            <div className="text-right">С прихода</div>
          </div>
          {docs.slice(0, shown).map((d) => {
            const isOpen = allOpen ? !openDocs.has(d.supplyId) : openDocs.has(d.supplyId) || (q.length > 0 && d.lines.length <= 12);
            const t = sumOf(d.lines);
            return (
              <div key={d.supplyId} className="border-b border-borderSoft">
                <div className={`grid ${grid} gap-3 py-2 pl-6 items-center text-[12.5px] cursor-pointer hover:bg-paper`} onClick={() => toggleDoc(d.supplyId)} title="Показать товары прихода">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Chevron open={isOpen} />
                    {fmtRuDate(d.date)}
                  </div>
                  <div className="break-words min-w-0">{d.docName || "—"}</div>
                  <div className="text-muted">{warehouseLabel(d.store)}</div>
                  <Cells qty={t.qty} cost={t.cost} sold={t.sold} remaining={t.remaining} date={d.date} />
                </div>
                {isOpen &&
                  [...d.lines]
                    .sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName, "ru"))
                    .map((l) => (
                      <div key={`${l.supplyId}-${l.lineNo}`} className={`grid ${grid} gap-3 py-1.5 pl-6 items-center text-[12px] text-muted`}>
                        <div />
                        <div className="col-span-2 break-words min-w-0" style={{ paddingLeft: 18 }}>
                          {l.productName}
                          {l.price !== null && <span className="text-mutedLight"> · {money(l.price)}/шт</span>}
                        </div>
                        <Cells qty={l.quantity} cost={l.quantity * (l.price ?? 0)} sold={l.quantity - l.remaining} remaining={l.remaining} date={l.date} />
                      </div>
                    ))}
              </div>
            );
          })}
          {docs.length > shown && (
            <button type="button" onClick={() => setShown((n) => n + DOCS_PAGE)} className="mt-2 ml-6 text-[12.5px] font-semibold text-accent">
              Показать ещё приёмки ({docs.length - shown})
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ReceiptsButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`text-[11px] font-semibold rounded-md border px-2 py-0.5 flex-none ${active ? "bg-accent text-paper border-accent" : "text-accent border-border hover:bg-paper"}`}
    >
      Приёмки
    </button>
  );
}

function SupplierTable({
  tab,
  rows,
  warehouseTotal,
  stockTotals,
  stores,
}: {
  tab: Tab;
  rows: SupplierRow[];
  warehouseTotal: number; // себестоимость всего склада (без учёта поиска) — знаменатель доли
  stockTotals: Map<string, number>; // себестоимость всех остатков поставщика (для вкладки «Зависшие»)
  stores: string[];
}) {
  const [openSuppliers, setOpenSuppliers] = useState<Set<string>>(new Set());
  const [openArticles, setOpenArticles] = useState<Set<string>>(new Set());
  const [openReceipts, setOpenReceipts] = useState<Set<string>>(new Set());
  // раскрытые приходы отдельного товара (ключ — артикул или id товара)
  const [openItemReceipts, setOpenItemReceipts] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Record<string, ItemRow[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [itemError, setItemError] = useState<string | null>(null);
  const storesKey = stores.join(",");

  // смена складов или вкладки — прежние раскрытия и кэш устарели
  useEffect(() => {
    setOpenSuppliers(new Set());
    setOpenArticles(new Set());
    setOpenReceipts(new Set());
    setOpenItemReceipts(new Set());
    setCache({});
  }, [storesKey, tab]);

  async function toggleSupplier(name: string) {
    const isOpen = openSuppliers.has(name);
    setOpenSuppliers((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(name);
      else next.add(name);
      return next;
    });
    if (isOpen || cache[name]) return;
    setLoading((prev) => new Set(prev).add(name));
    setItemError(null);
    try {
      type Raw = {
        product_ms_id: string;
        product_name: string;
        article: string;
        stock: number;
        money: number;
        sale_value: number;
        buy_price?: number | null;
        days_since_last_sale?: number | null;
      };
      const raw = await fetchAllRows<Raw>((from, to) =>
        (tab === "stale"
          ? supabase.rpc("stale_by_supplier_items", { p_stale_days: STALE_DAYS_QUERY, p_stores: stores, p_supplier: name })
          : supabase.rpc("stock_by_supplier_items", { p_stores: stores, p_supplier: name })
        ).range(from, to)
      );
      setCache((prev) => ({
        ...prev,
        [name]: raw.map((r) => ({
          id: r.product_ms_id,
          name: r.product_name,
          article: r.article,
          stock: Number(r.stock),
          money: Number(r.money),
          saleValue: Number(r.sale_value),
          buyPrice: r.buy_price != null ? Number(r.buy_price) : null,
          days: r.days_since_last_sale ?? null,
        })),
      }));
    } catch (e) {
      setItemError(getErrorMessage(e));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }

  function toggleItemReceipts(key: string) {
    setOpenItemReceipts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleArticle(key: string) {
    setOpenArticles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (rows.length === 0) {
    return <div className="text-sm text-muted py-4">{tab === "stale" ? "Зависших остатков у поставщиков нет." : "Остатков нет."}</div>;
  }

  const stale = tab === "stale";
  // на «Зависших» лишняя колонка: какая часть остатков поставщика зависла
  const grid = stale ? "grid-cols-[1.6fr_0.55fr_0.55fr_1fr_0.7fr_0.8fr_0.95fr]" : "grid-cols-[1.7fr_0.6fr_0.6fr_1fr_0.7fr_1fr]";
  const minW = stale ? "min-w-[980px]" : "min-w-[860px]";
  const supplierStock = (supplier: string, money: number) => (stale ? stockTotals.get(supplier) ?? 0 : money);
  const sumSupplierStock = rows.reduce((a, r) => a + supplierStock(r.supplier, r.money), 0);
  const sumStock = rows.reduce((a, r) => a + r.stock, 0);
  const sumMoney = rows.reduce((a, r) => a + r.money, 0);
  const sumSale = rows.reduce((a, r) => a + r.saleValue, 0);
  const sumArticles = rows.reduce((a, r) => a + r.articles, 0);

  return (
    <div className="overflow-x-auto">
      <div className={`${minW} grid ${grid} gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border`}>
        <div>Поставщик</div>
        <div className="text-right">Артикулов</div>
        <div className="text-right">Штук</div>
        <div className="text-right">{stale ? "Себестоимость зависшего" : "Себестоимость"}</div>
        <div className="text-right">Доля склада</div>
        {stale && <div className="text-right">Зависло у него</div>}
        <div className="text-right">{stale ? "Дней без продаж (макс.)" : "По цене продажи"}</div>
      </div>

      {rows.map((r) => {
        const isOpen = openSuppliers.has(r.supplier);
        const items = cache[r.supplier];
        const groups = items ? groupByArticle(items) : [];
        const ownStock = supplierStock(r.supplier, r.money);
        // доля поставщика в складе — по ВСЕМУ его остатку, а не только по зависшему
        const share = pct(ownStock, warehouseTotal);
        return (
          <div key={r.supplier} className={`${minW} border-b border-borderSoft`}>
            <div className={`grid ${grid} gap-3 py-3 items-center text-[13px] cursor-pointer hover:bg-paper`} onClick={() => toggleSupplier(r.supplier)}>
              <div className="flex items-center gap-2 font-semibold min-w-0 flex-wrap">
                <Chevron open={isOpen} />
                <span className="break-words">{r.supplier}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenReceipts((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.supplier)) next.delete(r.supplier);
                      else next.add(r.supplier);
                      return next;
                    });
                  }}
                  className={`text-[11.5px] font-semibold rounded-md border px-2 py-0.5 ${openReceipts.has(r.supplier) ? "bg-accent text-paper border-accent" : "text-accent border-border hover:bg-paper"}`}
                >
                  Приёмки
                </button>
              </div>
              <div className="num text-right">{num(r.articles)}</div>
              <div className="num text-right">{num(r.stock)}</div>
              <div className="num text-right font-semibold">{money(r.money)}</div>
              <div className="num text-right text-muted">{share}</div>
              {stale && <div className="num text-right text-muted">{pct(r.money, ownStock)}</div>}
              <div className="num text-right text-muted">
                {stale ? (r.maxDays === null ? "не продавался" : `${r.maxDays} дн.`) : money(r.saleValue)}
              </div>
            </div>

            {openReceipts.has(r.supplier) && <ReceiptsPanel supplier={r.supplier} stores={stores} />}

            {isOpen && (
              <div className="pb-2 bg-paper/40">
                {loading.has(r.supplier) && <div className="text-[12.5px] text-muted py-2 pl-9">Загрузка товаров…</div>}
                {itemError && !items && <div className="text-[12.5px] text-[#A34B36] py-2 pl-9">{itemError}</div>}
                {items && groups.length === 0 && <div className="text-[12.5px] text-mutedLight py-2 pl-9">Нет товаров.</div>}
                {groups.map((g) => {
                  const key = `${r.supplier}|${g.article}`;
                  const articleOpen = openArticles.has(key);
                  return (
                    <div key={key} className="border-t border-borderSoft">
                      <div
                        className={`grid ${grid} gap-3 py-2 items-center text-[12.5px] cursor-pointer hover:bg-paper`}
                        onClick={() => toggleArticle(key)}
                        title="Показать размеры"
                      >
                        <div className="flex items-center gap-2 min-w-0" style={{ paddingLeft: 24 }}>
                          <Chevron open={articleOpen} />
                          <span className="break-words">{g.article}</span>
                          <ReceiptsButton active={openItemReceipts.has(key)} onClick={() => toggleItemReceipts(key)} />
                        </div>
                        <div />
                        <div className="num text-right">{num(g.stock)}</div>
                        <div className="num text-right">{money(g.money)}</div>
                        <div className="num text-right text-muted">{pct(g.money, warehouseTotal)}</div>
                        {stale && <div />}
                        <div className="num text-right text-muted">
                          {stale ? (g.maxDays === null ? "не продавался" : `${g.maxDays} дн.`) : money(g.saleValue)}
                        </div>
                      </div>
                      {openItemReceipts.has(key) && (
                        <ReceiptsPanel supplier={r.supplier} stores={stores} productIds={g.items.map((x) => x.id)} title={g.article} />
                      )}
                      {articleOpen &&
                        [...g.items]
                          .sort((a, b) => b.stock - a.stock)
                          .map((it) => (
                            <div key={it.id}>
                            <div className={`grid ${grid} gap-3 py-1.5 items-center text-[12px] text-muted`}>
                              <div className="break-words min-w-0 flex items-center gap-2 flex-wrap" style={{ paddingLeft: 56 }}>
                                <span>
                                  {it.name}
                                  {it.buyPrice !== null && <span className="text-mutedLight"> · {money(it.buyPrice)}/шт</span>}
                                </span>
                                <ReceiptsButton active={openItemReceipts.has(it.id)} onClick={() => toggleItemReceipts(it.id)} />
                              </div>
                              <div />
                              <div className="num text-right">{num(it.stock)}</div>
                              <div className="num text-right">{money(it.money)}</div>
                              <div className="num text-right text-mutedLight">{pct(it.money, warehouseTotal)}</div>
                              {stale && <div />}
                              <div className="num text-right text-mutedLight">
                                {stale ? (it.days === null ? "не продавался" : `${it.days} дн.`) : money(it.saleValue)}
                              </div>
                            </div>
                            {openItemReceipts.has(it.id) && (
                              <ReceiptsPanel supplier={r.supplier} stores={stores} productIds={[it.id]} title={it.name} />
                            )}
                            </div>
                          ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className={`${minW} grid ${grid} gap-3 py-3 items-center text-[13px] font-bold bg-paper`}>
        <div className="pl-5">Итого</div>
        <div className="num text-right">{num(sumArticles)}</div>
        <div className="num text-right">{num(sumStock)}</div>
        <div className="num text-right">{money(sumMoney)}</div>
        <div className="num text-right text-muted">{pct(sumSupplierStock, warehouseTotal)}</div>
        {stale && <div className="num text-right text-muted">{pct(sumMoney, sumSupplierStock)}</div>}
        <div className="num text-right text-muted">{stale ? "" : money(sumSale)}</div>
      </div>
    </div>
  );
}

export default function SuppliersPage() {
  const { isAdmin, permissions, accessibleStoreCodes } = useAuth();
  const canView = isAdmin || permissions["warehouse.stock"].canView;

  // склады, где сейчас есть товар (пустые в фильтрах не показываем)
  const stocked = useStockedWarehouses();
  const accessibleWarehouseCodes = warehousesForCities(accessibleStoreCodes).filter((c) => !stocked || stocked.has(c));
  const frozenAvailable = !stocked || stocked.has("frozen");
  const [tab, setTab] = useState<Tab>("stock");
  const [storeFilter, setStoreFilter] = useState<string[]>([]);
  const [frozenStock, setFrozenStock] = useState(true); // для остатков заморозка входит в общий себес
  const [frozenStale, setFrozenStale] = useState(false); // зависшие считаем по складам, заморозка — отдельная корзина
  const [search, setSearch] = useState("");

  const baseStores = storeFilter.length > 0 ? storeFilter : accessibleWarehouseCodes;
  const stockStores = useMemo(() => (frozenStock && frozenAvailable ? [...baseStores, "frozen"] : baseStores), [baseStores, frozenStock, frozenAvailable]);
  const staleStores = useMemo(() => (frozenStale && frozenAvailable ? [...baseStores, "frozen"] : baseStores), [baseStores, frozenStale, frozenAvailable]);
  const stockKey = stockStores.join(",");
  const staleKey = staleStores.join(",");

  const [stockRows, setStockRows] = useState<SupplierRow[]>([]);
  const [staleRows, setStaleRows] = useState<SupplierRow[]>([]);
  const [stockTotalsForStale, setStockTotalsForStale] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      type StockRaw = { supplier_name: string; skus: number; articles: number; stock: number; money: number; sale_value: number };
      type StaleRaw = StockRaw & { max_days: number | null };
      const [stock, stale, stockForShare] = await Promise.all([
        fetchAllRows<StockRaw>((from, to) => supabase.rpc("stock_by_supplier", { p_stores: stockStores }).range(from, to)),
        fetchAllRows<StaleRaw>((from, to) => supabase.rpc("stale_by_supplier", { p_stale_days: STALE_DAYS_QUERY, p_stores: staleStores }).range(from, to)),
        // доля зависшего считается от остатков поставщика на тех же складах, что и зависшее
        fetchAllRows<StockRaw>((from, to) => supabase.rpc("stock_by_supplier", { p_stores: staleStores }).range(from, to)),
      ]);
      if (my !== seq.current) return;
      const map = (r: StockRaw | StaleRaw): SupplierRow => ({
        supplier: r.supplier_name,
        skus: Number(r.skus),
        articles: Number(r.articles),
        stock: Number(r.stock),
        money: Number(r.money),
        saleValue: Number(r.sale_value),
        maxDays: "max_days" in r ? (r.max_days ?? null) : null,
      });
      setStockRows(stock.map(map).sort((a, b) => b.money - a.money));
      setStaleRows(stale.map(map).sort((a, b) => b.money - a.money));
      setStockTotalsForStale(new Map(stockForShare.map((r) => [r.supplier_name, Number(r.money)])));
    } catch (e) {
      if (my !== seq.current) return;
      setError(getErrorMessage(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockKey, staleKey]);

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

  const q = search.trim().toLowerCase();
  const rows = (tab === "stock" ? stockRows : staleRows).filter((r) => !q || r.supplier.toLowerCase().includes(q));
  const totalMoney = rows.reduce((a, r) => a + r.money, 0);
  // себестоимость всего склада на выбранных складах — для «доли склада» (поиск по поставщику её не меняет)
  const warehouseTotal = tab === "stock" ? stockRows.reduce((a, r) => a + r.money, 0) : Array.from(stockTotalsForStale.values()).reduce((a, v) => a + v, 0);
  const totalStock = rows.reduce((a, r) => a + r.stock, 0);
  const totalSale = rows.reduce((a, r) => a + r.saleValue, 0);
  const tableStores = tab === "stock" ? stockStores : staleStores;

  function toggleStore(code: string) {
    setStoreFilter((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  function exportXls() {
    if (tab === "stock") {
      downloadExcel(
        "Остатки_по_поставщикам",
        ["Поставщик", "Артикулов", "Штук", "Себестоимость", "Доля склада, %", "По цене продажи"],
        rows.map((r) => [r.supplier, r.articles, Math.round(r.stock), Math.round(r.money), warehouseTotal > 0 ? Math.round((r.money / warehouseTotal) * 1000) / 10 : 0, Math.round(r.saleValue)])
      );
    } else {
      downloadExcel(
        "Зависшие_по_поставщикам",
        ["Поставщик", "Артикулов", "Штук", "Себестоимость зависшего", "Доля склада, %", "Зависло от остатков поставщика, %", "Дней без продаж (макс.)"],
        rows.map((r) => {
          const total = stockTotalsForStale.get(r.supplier) ?? 0;
          return [r.supplier, r.articles, Math.round(r.stock), Math.round(r.money), warehouseTotal > 0 ? Math.round((total / warehouseTotal) * 1000) / 10 : 0, total > 0 ? Math.round((r.money / total) * 1000) / 10 : 0, r.maxDays ?? "не продавался"];
        })
      );
    }
  }

  const checkbox = "flex items-center gap-1.5 text-[13px] cursor-pointer";
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Склад</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">По поставщикам</h1>
        <p className="text-sm text-muted max-w-2xl mt-1">
          Что лежит на складе у каждого поставщика: артикулы, штуки и себестоимость. Нажмите на поставщика — откроются его товары, на артикул — размеры.
          Поставщик берётся из карточки товара в МойСклад.
        </p>
        {error && (
          <div className="flex items-center gap-3 text-sm text-[#A34B36]">
            <span>Не удалось загрузить: {error}</span>
            <button type="button" onClick={load} className="font-semibold underline">
              Повторить
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {([
          ["stock", "Остатки по поставщикам"],
          ["stale", "Зависшие остатки по поставщикам"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`text-[13px] px-4 py-2.5 -mb-px border-b-2 ${tab === key ? "border-accent text-ink font-bold" : "border-transparent text-muted font-medium hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-5 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted">Склады</span>
          <div className="flex items-center gap-4 flex-wrap">
            {WAREHOUSES.filter((w) => accessibleWarehouseCodes.includes(w.code)).map((w) => (
              <label key={w.code} className={checkbox}>
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={storeFilter.length === 0 || storeFilter.includes(w.code)}
                  onChange={() => {
                    if (storeFilter.length === 0) setStoreFilter(accessibleWarehouseCodes.filter((c) => c !== w.code));
                    else toggleStore(w.code);
                  }}
                />
                {w.label}
              </label>
            ))}
            {frozenAvailable && (tab === "stock" ? (
              <label className={checkbox}>
                <input type="checkbox" className="accent-accent" checked={frozenStock} onChange={(e) => setFrozenStock(e.target.checked)} />
                Заморозка
              </label>
            ) : (
              <label className={checkbox}>
                <input type="checkbox" className="accent-accent" checked={frozenStale} onChange={(e) => setFrozenStale(e.target.checked)} />
                Заморозка
              </label>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted">Поставщик</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Название…"
            className="bg-paper border border-border rounded-lg px-3 py-2 text-[13px] w-[220px]"
          />
        </label>
        <PdfButton
          disabled={rows.length === 0}
          build={(): PdfDoc => {
            const stale = tab === "stale";
            const labels = tableStores.map((c) => WAREHOUSES.find((w) => w.code === c)?.label ?? (c === "frozen" ? "Заморозка" : c));
            const supplierStock = (r: SupplierRow) => (stale ? stockTotalsForStale.get(r.supplier) ?? 0 : r.money);
            const sumSupplierStock = rows.reduce((a, r) => a + supplierStock(r), 0);
            const body: (string | number)[][] = rows.map((r) =>
              stale
                ? [r.supplier, num(r.articles), num(r.stock), money(r.money), pct(supplierStock(r), warehouseTotal), pct(r.money, supplierStock(r)), r.maxDays === null ? "не продавался" : `${r.maxDays} дн.`]
                : [r.supplier, num(r.articles), num(r.stock), money(r.money), pct(r.money, warehouseTotal), money(r.saleValue)]
            );
            const sumArticles = rows.reduce((a, r) => a + r.articles, 0);
            body.push(
              stale
                ? ["Итого", num(sumArticles), num(totalStock), money(totalMoney), pct(sumSupplierStock, warehouseTotal), pct(totalMoney, sumSupplierStock), ""]
                : ["Итого", num(sumArticles), num(totalStock), money(totalMoney), pct(totalMoney, warehouseTotal), money(totalSale)]
            );
            return {
              fileName: stale ? "Зависшие_по_поставщикам" : "Остатки_по_поставщикам",
              title: stale ? "Зависшие остатки по поставщикам" : "Остатки по поставщикам",
              subtitle: `Склады: ${labels.join(", ")}${search.trim() ? ` · поставщик: «${search.trim()}»` : ""}`,
              meta: stale
                ? [`Зависшим считается товар без продаж и приходов дольше ${STALE_DAYS} дней`, "«Доля склада» — доля поставщика в себестоимости всего склада", "«Зависло у него» — какая часть остатков самого поставщика зависла"]
                : ["«Доля склада» — доля поставщика в себестоимости всего склада", "Поставщик — из карточки товара в МойСклад"],
              kpis: [
                { label: "Поставщиков", value: String(rows.length) },
                { label: "Штук", value: num(totalStock) },
                { label: stale ? "Себестоимость зависшего" : "Себестоимость", value: money(totalMoney) },
                { label: "По цене продажи", value: money(totalSale) },
              ],
              sections: [
                {
                  title: stale ? "Зависшие по поставщикам" : "Остатки по поставщикам",
                  headers: stale
                    ? ["Поставщик", "Артикулов", "Штук", "Себестоимость зависшего", "Доля склада", "Зависло у него", "Дней без продаж (макс.)"]
                    : ["Поставщик", "Артикулов", "Штук", "Себестоимость", "Доля склада", "По цене продажи"],
                  rows: body,
                  rowKinds: body.map((_, i) => (i === body.length - 1 ? "total" : "normal")),
                  widths: stale ? [2.6, 1, 1, 1.7, 1.1, 1.1, 1.5] : [2.8, 1, 1, 1.7, 1.2, 1.7],
                },
                {
                  title: "Товары каждого поставщика",
                  hint: "Поставщик → артикул → размеры: сколько штук, на какую сумму. Можно оставить только нужные уровни и поставщиков.",
                  optional: true,
                  levelLabels: ["Только поставщики", "+ артикулы", "+ артикулы и размеры"],
                  headers: ["Поставщик / артикул / размер", "Штук", "Себестоимость", "Цена прихода", stale ? "Дней без продаж" : "По цене продажи"],
                  widths: [3.6, 0.9, 1.6, 1.3, 1.5],
                  rows: [],
                  load: async () => {
                    type Raw = { product_ms_id: string; product_name: string; article: string; stock: number; money: number; sale_value: number; buy_price?: number | null; days_since_last_sale?: number | null };
                    const names = rows.map((r) => r.supplier);
                    const itemsBy = new Map<string, ItemRow[]>();
                    let next = 0;
                    const worker = async () => {
                      while (next < names.length) {
                        const name = names[next++];
                        const raw = await fetchAllRows<Raw>((from, to) =>
                          (stale
                            ? supabase.rpc("stale_by_supplier_items", { p_stale_days: STALE_DAYS_QUERY, p_stores: tableStores, p_supplier: name })
                            : supabase.rpc("stock_by_supplier_items", { p_stores: tableStores, p_supplier: name })
                          ).range(from, to)
                        );
                        itemsBy.set(
                          name,
                          raw.map((r) => ({
                            id: r.product_ms_id,
                            name: r.product_name,
                            article: r.article,
                            stock: Number(r.stock),
                            money: Number(r.money),
                            saleValue: Number(r.sale_value),
                            buyPrice: r.buy_price != null ? Number(r.buy_price) : null,
                            days: r.days_since_last_sale ?? null,
                          }))
                        );
                      }
                    };
                    await Promise.all([worker(), worker(), worker(), worker()]);
                    const out: (string | number)[][] = [];
                    const kinds: ("group" | "sub")[] = [];
                    const indent: number[] = [];
                    const last = (v: number | null) => (v === null ? "не продавался" : `${v} дн.`);
                    for (const r of rows) {
                      out.push([r.supplier, num(r.stock), money(r.money), "", stale ? (r.maxDays === null ? "не продавался" : `${r.maxDays} дн.`) : money(r.saleValue)]);
                      kinds.push("group");
                      indent.push(0);
                      for (const g of groupByArticle(itemsBy.get(r.supplier) ?? [])) {
                        out.push([g.article, num(g.stock), money(g.money), "", stale ? last(g.maxDays) : money(g.saleValue)]);
                        kinds.push("sub");
                        indent.push(1);
                        for (const it of [...g.items].sort((a, b) => b.stock - a.stock)) {
                          out.push([it.name, num(it.stock), money(it.money), it.buyPrice !== null ? money(it.buyPrice) : "", stale ? last(it.days) : money(it.saleValue)]);
                          kinds.push("sub");
                          indent.push(2);
                        }
                      }
                    }
                    return { headers: [], rows: out, rowKinds: kinds, indent };
                  },
                },
              ],
            };
          }}
        />
        <button type="button" onClick={exportXls} className="text-[13px] font-semibold text-accent bg-surface border border-border rounded-md px-3.5 py-2 hover:bg-paper">
          Скачать Excel
        </button>
      </div>

      {tab === "stale" && (
        <p className="text-[12.5px] text-muted max-w-2xl -mt-2">
          Зависшим считается товар, который не продавался и не приходил на склад дольше {STALE_DAYS} дней (то же правило, что на странице «Зависшие остатки»).
          «Доля склада» — какую часть всего склада по себестоимости занимает этот поставщик. «Зависло у него» — какая часть остатков самого поставщика зависла.
        </p>
      )}

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-3xl">
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Поставщиков</div>
              <div className="font-serif text-[26px] font-semibold num">{rows.length.toLocaleString("ru-RU")}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Штук</div>
              <div className="font-serif text-[26px] font-semibold num">{num(totalStock)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">{tab === "stale" ? "Себестоимость зависшего" : "Себестоимость"}</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalMoney)}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">По цене продажи</div>
              <div className="font-serif text-[26px] font-semibold num">{money(totalSale)}</div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <SupplierTable tab={tab} rows={rows} warehouseTotal={warehouseTotal} stockTotals={stockTotalsForStale} stores={tableStores} />
          </div>
        </>
      )}
    </>
  );
}
