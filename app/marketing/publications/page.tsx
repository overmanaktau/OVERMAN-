"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";
import { DataTableCard } from "@/components/DataTableCard";

const PERIODS = ["Вчера", "Прошлая неделя", "Эта неделя", "С начала месяца", "Прошлый месяц", "Всё время"];
const DEFAULT_PERIOD = 3; // "С начала месяца"

const WEEKDAY_LABELS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const WEEKDAY_JS_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Date#getDay(): 0 = Sunday

const POST_TYPE_LABEL: Record<string, string> = { post: "Пост", reel: "Рилс" };
const SOURCE_LABEL: Record<string, string> = { organic: "Органика", ads: "Реклама" };

type PublicationEntry = {
  id: number;
  store: string;
  entry_date: string;
  entry_time: string | null;
  post_type: "post" | "reel";
  source: "organic" | "ads";
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  caption: string | null;
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

function getPeriodRange(index: number, today: Date): { start: Date; end: Date } {
  const d = stripTime(today);
  const dow = d.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = addDays(d, mondayOffset);
  const thisSunday = addDays(thisMonday, 6);

  if (index === 0) {
    // Вчера
    return { start: addDays(d, -1), end: addDays(d, -1) };
  }
  if (index === 1) {
    // Прошлая неделя
    return { start: addDays(thisMonday, -7), end: addDays(thisSunday, -7) };
  }
  if (index === 2) {
    // Эта неделя
    return { start: thisMonday, end: thisSunday };
  }
  if (index === 3) {
    // С начала месяца
    return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: d };
  }
  if (index === 4) {
    // Прошлый месяц
    return { start: new Date(d.getFullYear(), d.getMonth() - 1, 1), end: new Date(d.getFullYear(), d.getMonth(), 0) };
  }
  // Всё время
  return { start: new Date(2000, 0, 1), end: d };
}

function parseYmd(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export default function PublicationsPage() {
  const { isAdmin, permissions, cities, stores, accessibleStoreCodes } = useAuth();
  const canView = isAdmin || permissions["marketing.publications"].canView;
  const canEdit = isAdmin || permissions["marketing.publications"].canEdit;

  const accessibleStores = useMemo(
    () => stores.filter((s) => accessibleStoreCodes.includes(s.code)),
    [stores, accessibleStoreCodes]
  );
  const accessibleCities = useMemo(
    () => cities.filter((c) => accessibleStores.some((s) => s.city_id === c.id)),
    [cities, accessibleStores]
  );

  const [periodIndex, setPeriodIndex] = useState(DEFAULT_PERIOD);
  const [activeCustom, setActiveCustom] = useState<{ start: string; end: string } | null>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customPickerRef = useRef<HTMLDivElement>(null);
  const [cityFilter, setCityFilter] = useState<number | "all">("all");

  const filterStoreCodes = useMemo(
    () =>
      (cityFilter === "all" ? accessibleStores : accessibleStores.filter((s) => s.city_id === cityFilter)).map(
        (s) => s.code
      ),
    [accessibleStores, cityFilter]
  );

  const [entries, setEntries] = useState<PublicationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (filterStoreCodes.length === 0) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { start, end } = activeCustom
        ? { start: parseYmd(activeCustom.start), end: parseYmd(activeCustom.end) }
        : getPeriodRange(periodIndex, new Date());
      const { data, error: err } = await supabase
        .from("publication_entries")
        .select("*")
        .in("store", filterStoreCodes)
        .gte("entry_date", ymd(start))
        .lte("entry_date", ymd(end))
        .order("entry_date", { ascending: false })
        .order("entry_time", { ascending: false });
      if (err) throw err;
      setEntries((data ?? []) as PublicationEntry[]);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [periodIndex, activeCustom?.start, activeCustom?.end, filterStoreCodes.join(",")]);

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

  function applyCustomRange() {
    if (!customStart || !customEnd || customStart > customEnd) return;
    setActiveCustom({ start: customStart, end: customEnd });
    setShowCustomPicker(false);
  }

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Публикации».</p>
      </div>
    );
  }

  if (accessibleStores.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа ни к одной точке продаж.</p>
      </div>
    );
  }

  function storeName(code: string) {
    return stores.find((s) => s.code === code)?.name ?? code;
  }

  const totalCount = entries.length;
  const avgReach = avg(entries.map((e) => e.reach));
  const avgViews = avg(entries.map((e) => e.views));
  const avgShares = avg(entries.map((e) => e.shares));

  const weekdayRows = WEEKDAY_JS_ORDER.map((jsDay, i) => {
    const rows = entries.filter((e) => new Date(`${e.entry_date}T00:00:00`).getDay() === jsDay);
    return {
      label: WEEKDAY_LABELS[i],
      count: rows.length,
      reach: avg(rows.map((r) => r.reach)),
      views: avg(rows.map((r) => r.views)),
      shares: avg(rows.map((r) => r.shares)),
    };
  });

  const hourBuckets = new Map<number, PublicationEntry[]>();
  for (const e of entries) {
    if (!e.entry_time) continue;
    const hour = Number(e.entry_time.split(":")[0]);
    if (!hourBuckets.has(hour)) hourBuckets.set(hour, []);
    hourBuckets.get(hour)!.push(e);
  }
  const hourRows = Array.from(hourBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([hour, rows]) => ({
      hour,
      count: rows.length,
      reach: avg(rows.map((r) => r.reach)),
      views: avg(rows.map((r) => r.views)),
      shares: avg(rows.map((r) => r.shares)),
    }));

  const typeRows = (["post", "reel"] as const).map((type) => {
    const rows = entries.filter((e) => e.post_type === type);
    return {
      type,
      count: rows.length,
      reach: avg(rows.map((r) => r.reach)),
      views: avg(rows.map((r) => r.views)),
      shares: avg(rows.map((r) => r.shares)),
      reactions: avg(rows.map((r) => r.likes + r.comments)),
    };
  });

  async function handleDelete(id: number) {
    if (!window.confirm("Удалить эту публикацию?")) return;
    setError(null);
    try {
      const { error: err } = await supabase.from("publication_entries").delete().eq("id", id);
      if (err) throw err;
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Маркетинг</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Публикации</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Учёт вышедших публикаций в Instagram: охваты, просмотры и реакции будут подтягиваться
          автоматически по каждому посту или рилсу.
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

      <div className="flex items-center gap-3 flex-wrap">
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
              className={`text-[13px] rounded-md px-3.5 py-2 disabled:opacity-60 ${
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
              <div className="absolute left-0 top-full mt-2 z-50 bg-surface border border-border rounded-lg shadow-lg p-3.5 flex flex-col gap-2.5 w-[230px]">
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

        <select
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="text-[13px] font-semibold bg-surface border border-border rounded-lg px-3 py-2.5"
        >
          <option value="all">Все города</option>
          {accessibleCities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="bg-surface border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Публикаций</div>
              <div className="font-serif text-[26px] font-semibold num">{totalCount}</div>
            </div>
            <div className="bg-surface border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Средний охват</div>
              <div className="font-serif text-[26px] font-semibold num">{avgReach.toLocaleString("ru-RU")}</div>
            </div>
            <div className="bg-surface border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Средние просмотры</div>
              <div className="font-serif text-[26px] font-semibold num">{avgViews.toLocaleString("ru-RU")}</div>
            </div>
            <div className="bg-surface border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Переслано в среднем</div>
              <div className="font-serif text-[26px] font-semibold num">{avgShares.toLocaleString("ru-RU")}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DataTableCard
              title="По дню недели"
              rows={weekdayRows}
              getSearchText={(r) => r.label}
              csvHeaders={["День", "Постов", "Охват", "Просмотры", "Переслано"]}
              toCsvRow={(r) => [r.label, r.count, r.reach, r.views, r.shares]}
              csvFilename="publications-by-weekday.csv"
            >
              {(rows) => (
                <>
                  <div className="min-w-[520px] grid grid-cols-[1.3fr_0.7fr_0.8fr_0.8fr_0.8fr] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                    <div>День</div>
                    <div>Постов</div>
                    <div>Охват</div>
                    <div>Просмотры</div>
                    <div>Переслано</div>
                  </div>
                  {rows.map((r) => (
                    <div
                      key={r.label}
                      className="min-w-[520px] grid grid-cols-[1.3fr_0.7fr_0.8fr_0.8fr_0.8fr] gap-2 py-1.5 border-b border-borderSoft text-[13px] items-center"
                    >
                      <div>{r.label}</div>
                      <div className="num">{r.count}</div>
                      <div className="num text-muted">{r.reach.toLocaleString("ru-RU")}</div>
                      <div className="num text-muted">{r.views.toLocaleString("ru-RU")}</div>
                      <div className="num text-muted">{r.shares.toLocaleString("ru-RU")}</div>
                    </div>
                  ))}
                </>
              )}
            </DataTableCard>

            <DataTableCard
              title="По времени публикации"
              rows={hourRows}
              getSearchText={(r) => pad2(r.hour)}
              csvHeaders={["Час", "Постов", "Охват", "Просмотры", "Переслано"]}
              toCsvRow={(r) => [pad2(r.hour), r.count, r.reach, r.views, r.shares]}
              csvFilename="publications-by-hour.csv"
            >
              {(rows) =>
                rows.length === 0 ? (
                  <div className="text-sm text-muted py-4">Нет публикаций с указанным временем</div>
                ) : (
                  <>
                    <div className="min-w-[520px] grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                      <div>Час</div>
                      <div>Постов</div>
                      <div>Охват</div>
                      <div>Просмотры</div>
                      <div>Переслано</div>
                    </div>
                    <div className="max-h-[280px] overflow-y-auto flex flex-col">
                      {rows.map((r) => (
                        <div
                          key={r.hour}
                          className="min-w-[520px] grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr] gap-2 py-1.5 border-b border-borderSoft text-[13px] items-center"
                        >
                          <div>{pad2(r.hour)}</div>
                          <div className="num">{r.count}</div>
                          <div className="num text-muted">{r.reach.toLocaleString("ru-RU")}</div>
                          <div className="num text-muted">{r.views.toLocaleString("ru-RU")}</div>
                          <div className="num text-muted">{r.shares.toLocaleString("ru-RU")}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )
              }
            </DataTableCard>
          </div>

          <DataTableCard
            title="По типу"
            rows={typeRows}
            getSearchText={(r) => POST_TYPE_LABEL[r.type]}
            csvHeaders={["Тип", "Постов", "Охват", "Просмотры", "Переслано", "Реакции"]}
            toCsvRow={(r) => [POST_TYPE_LABEL[r.type], r.count, r.reach, r.views, r.shares, r.reactions]}
            csvFilename="publications-by-type.csv"
          >
            {(rows) => (
              <>
                <div className="min-w-[620px] grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr_1fr] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                  <div>Тип</div>
                  <div>Постов</div>
                  <div>Охват</div>
                  <div>Просмотры</div>
                  <div>Переслано</div>
                  <div>Реакции</div>
                </div>
                {rows.map((r) => (
                  <div
                    key={r.type}
                    className="min-w-[620px] grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr_1fr] gap-2 py-1.5 border-b border-borderSoft text-[13px] items-center"
                  >
                    <div className="font-semibold">{POST_TYPE_LABEL[r.type]}</div>
                    <div className="num">{r.count}</div>
                    <div className="num text-muted">{r.reach.toLocaleString("ru-RU")}</div>
                    <div className="num text-muted">{r.views.toLocaleString("ru-RU")}</div>
                    <div className="num text-muted">{r.shares.toLocaleString("ru-RU")}</div>
                    <div className="num text-muted">{r.reactions.toLocaleString("ru-RU")}</div>
                  </div>
                ))}
              </>
            )}
          </DataTableCard>

          <DataTableCard
            title="Все публикации периода"
            rows={entries}
            getSearchText={(e) =>
              [
                e.entry_date,
                e.entry_time ?? "",
                POST_TYPE_LABEL[e.post_type],
                SOURCE_LABEL[e.source],
                storeName(e.store),
                e.caption ?? "",
              ].join(" ")
            }
            csvHeaders={["Дата", "Время", "День", "Тип", "Источник", "Магазин", "Охват", "Просмотры", "Лайки", "Комменты", "Переслано", "Текст"]}
            toCsvRow={(e) => {
              const jsDay = new Date(`${e.entry_date}T00:00:00`).getDay();
              const weekdayLabel = WEEKDAY_LABELS[WEEKDAY_JS_ORDER.indexOf(jsDay)];
              return [
                e.entry_date,
                e.entry_time ? e.entry_time.slice(0, 5) : "",
                weekdayLabel,
                POST_TYPE_LABEL[e.post_type],
                SOURCE_LABEL[e.source],
                storeName(e.store),
                e.reach,
                e.views,
                e.likes,
                e.comments,
                e.shares,
                e.caption ?? "",
              ];
            }}
            csvFilename="publications.csv"
          >
            {(rows) =>
              rows.length === 0 ? (
                <div className="text-sm text-muted py-4">Нет публикаций за выбранный период</div>
              ) : (
                <div className="max-h-[520px] overflow-auto rounded-md">
                  <div className="min-w-[1320px]">
                    <div className="sticky top-0 z-10 bg-surface grid grid-cols-[60px_54px_96px_56px_78px_110px_68px_80px_58px_74px_78px_1fr_56px] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                      <div>Дата</div>
                      <div>Время</div>
                      <div>День</div>
                      <div>Тип</div>
                      <div>Источник</div>
                      <div>Магазин</div>
                      <div>Охват</div>
                      <div>Просмотры</div>
                      <div>Лайки</div>
                      <div>Комменты</div>
                      <div>Переслано</div>
                      <div>Текст</div>
                      <div></div>
                    </div>
                    {rows.map((e) => {
                      const jsDay = new Date(`${e.entry_date}T00:00:00`).getDay();
                      const weekdayLabel = WEEKDAY_LABELS[WEEKDAY_JS_ORDER.indexOf(jsDay)];
                      return (
                        <div
                          key={e.id}
                          className="grid grid-cols-[60px_54px_96px_56px_78px_110px_68px_80px_58px_74px_78px_1fr_56px] gap-2 items-center py-1.5 border-b border-borderSoft text-[12.5px]"
                        >
                          <div className="text-muted">{e.entry_date.slice(8, 10)}.{e.entry_date.slice(5, 7)}</div>
                          <div className="text-muted">{e.entry_time ? e.entry_time.slice(0, 5) : "—"}</div>
                          <div className="text-mutedLight truncate">{weekdayLabel}</div>
                          <div>{POST_TYPE_LABEL[e.post_type]}</div>
                          <div className="text-muted">{SOURCE_LABEL[e.source]}</div>
                          <div className="truncate">{storeName(e.store)}</div>
                          <div className="num">{e.reach.toLocaleString("ru-RU")}</div>
                          <div className="num">{e.views.toLocaleString("ru-RU")}</div>
                          <div className="num">{e.likes.toLocaleString("ru-RU")}</div>
                          <div className="num">{e.comments.toLocaleString("ru-RU")}</div>
                          <div className="num">{e.shares.toLocaleString("ru-RU")}</div>
                          <div className="text-muted truncate" title={e.caption ?? ""}>
                            {e.caption ?? "—"}
                          </div>
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={() => handleDelete(e.id)}
                              className="text-[#A34B36] font-semibold text-left"
                            >
                              Удалить
                            </button>
                          ) : (
                            <div />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )
            }
          </DataTableCard>
        </>
      )}
    </>
  );
}
