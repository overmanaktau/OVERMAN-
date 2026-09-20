"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

const PERIODS = ["7 дней", "30 дней", "90 дней", "Этот месяц", "Всё время"];
const DEFAULT_PERIOD = 2; // "90 дней"

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

type NewEntry = {
  entry_date: string;
  entry_time: string;
  post_type: "post" | "reel";
  source: "organic" | "ads";
  store: string;
  reach: string;
  views: string;
  likes: string;
  comments: string;
  shares: string;
  caption: string;
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
  const end = stripTime(today);
  if (index === 0) return { start: addDays(end, -6), end };
  if (index === 1) return { start: addDays(end, -29), end };
  if (index === 2) return { start: addDays(end, -89), end };
  if (index === 3) return { start: new Date(end.getFullYear(), end.getMonth(), 1), end };
  return { start: new Date(2000, 0, 1), end };
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function emptyNewEntry(store: string): NewEntry {
  return {
    entry_date: ymd(new Date()),
    entry_time: "",
    post_type: "post",
    source: "organic",
    store,
    reach: "",
    views: "",
    likes: "",
    comments: "",
    shares: "",
    caption: "",
  };
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
  const [cityFilter, setCityFilter] = useState<number | "all">("all");
  const [storeFilter, setStoreFilter] = useState<string | "all">("all");

  const storesForCity = useMemo(
    () => (cityFilter === "all" ? accessibleStores : accessibleStores.filter((s) => s.city_id === cityFilter)),
    [accessibleStores, cityFilter]
  );

  useEffect(() => {
    if (storeFilter !== "all" && !storesForCity.some((s) => s.code === storeFilter)) {
      setStoreFilter("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storesForCity.map((s) => s.code).join(",")]);

  const filterStoreCodes = useMemo(
    () => (storeFilter === "all" ? storesForCity.map((s) => s.code) : [storeFilter]),
    [storeFilter, storesForCity]
  );

  const [entries, setEntries] = useState<PublicationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newEntry, setNewEntry] = useState<NewEntry>(() => emptyNewEntry(""));

  useEffect(() => {
    setNewEntry((prev) => (prev.store ? prev : { ...prev, store: accessibleStores[0]?.code ?? "" }));
  }, [accessibleStores]);

  const load = useCallback(async () => {
    if (filterStoreCodes.length === 0) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { start, end } = getPeriodRange(periodIndex, new Date());
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
  }, [periodIndex, filterStoreCodes.join(",")]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canView) {
    return (
      <div className="bg-white border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Публикации».</p>
      </div>
    );
  }

  if (accessibleStores.length === 0) {
    return (
      <div className="bg-white border border-border rounded-card p-8 max-w-md">
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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newEntry.store) return;
    setCreating(true);
    setError(null);
    try {
      const payload = {
        store: newEntry.store,
        entry_date: newEntry.entry_date,
        entry_time: newEntry.entry_time || null,
        post_type: newEntry.post_type,
        source: newEntry.source,
        reach: newEntry.reach === "" ? 0 : Number(newEntry.reach),
        views: newEntry.views === "" ? 0 : Number(newEntry.views),
        likes: newEntry.likes === "" ? 0 : Number(newEntry.likes),
        comments: newEntry.comments === "" ? 0 : Number(newEntry.comments),
        shares: newEntry.shares === "" ? 0 : Number(newEntry.shares),
        caption: newEntry.caption.trim() || null,
      };
      const { error: err } = await supabase.from("publication_entries").insert(payload);
      if (err) throw err;
      setNewEntry(emptyNewEntry(newEntry.store));
      setAdding(false);
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }

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
          Учёт вышедших публикаций в Instagram: охваты, просмотры и реакции вносятся вручную по
          каждому посту или рилсу.
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
        <div className="flex items-center gap-1.5 bg-white border border-border rounded-card p-1.5 w-fit">
          {PERIODS.map((p, i) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriodIndex(i)}
              disabled={loading}
              className={`text-[13px] rounded-md px-3.5 py-2 disabled:opacity-60 ${
                i === periodIndex ? "bg-accent text-paper font-bold" : "text-muted font-medium"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <select
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="text-[13px] font-semibold bg-white border border-border rounded-lg px-3 py-2.5"
        >
          <option value="all">Все города</option>
          {accessibleCities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          value={storeFilter}
          onChange={(e) => setStoreFilter(e.target.value)}
          className="text-[13px] font-semibold bg-white border border-border rounded-lg px-3 py-2.5"
        >
          <option value="all">Все точки</option>
          {storesForCity.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>

        {canEdit && (
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="ml-auto text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5"
          >
            {adding ? "Отмена" : "+ Добавить публикацию"}
          </button>
        )}
      </div>

      {adding && canEdit && (
        <form
          onSubmit={handleCreate}
          className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
        >
          <div className="text-[15px] font-bold">Новая публикация</div>
          <div className="grid grid-cols-4 gap-3">
            <input
              type="date"
              required
              value={newEntry.entry_date}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, entry_date: e.target.value }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            />
            <input
              type="time"
              value={newEntry.entry_time}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, entry_time: e.target.value }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            />
            <select
              value={newEntry.post_type}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, post_type: e.target.value as "post" | "reel" }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            >
              <option value="post">Пост</option>
              <option value="reel">Рилс</option>
            </select>
            <select
              value={newEntry.source}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, source: e.target.value as "organic" | "ads" }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            >
              <option value="organic">Органика</option>
              <option value="ads">Реклама</option>
            </select>
          </div>
          <div className="grid grid-cols-6 gap-3">
            <select
              value={newEntry.store}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, store: e.target.value }))}
              className="col-span-1 border border-border rounded-lg px-3 py-2.5 text-sm"
            >
              {accessibleStores.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              placeholder="Охват"
              value={newEntry.reach}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, reach: e.target.value }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            />
            <input
              type="number"
              min={0}
              placeholder="Просмотры"
              value={newEntry.views}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, views: e.target.value }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            />
            <input
              type="number"
              min={0}
              placeholder="Лайки"
              value={newEntry.likes}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, likes: e.target.value }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            />
            <input
              type="number"
              min={0}
              placeholder="Комменты"
              value={newEntry.comments}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, comments: e.target.value }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            />
            <input
              type="number"
              min={0}
              placeholder="Переслано"
              value={newEntry.shares}
              onChange={(e) => setNewEntry((prev) => ({ ...prev, shares: e.target.value }))}
              className="border border-border rounded-lg px-3 py-2.5 text-sm"
            />
          </div>
          <textarea
            placeholder="Текст публикации (необязательно)"
            value={newEntry.caption}
            onChange={(e) => setNewEntry((prev) => ({ ...prev, caption: e.target.value }))}
            rows={2}
            className="border border-border rounded-lg px-3 py-2.5 text-sm resize-none"
          />
          <button
            type="submit"
            disabled={creating}
            className="self-start text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
          >
            {creating ? "Сохраняем…" : "Сохранить публикацию"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3.5">
            <div className="bg-white border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Публикаций</div>
              <div className="font-serif text-[26px] font-semibold num">{totalCount}</div>
            </div>
            <div className="bg-white border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Средний охват</div>
              <div className="font-serif text-[26px] font-semibold num">{avgReach.toLocaleString("ru-RU")}</div>
            </div>
            <div className="bg-white border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Средние просмотры</div>
              <div className="font-serif text-[26px] font-semibold num">{avgViews.toLocaleString("ru-RU")}</div>
            </div>
            <div className="bg-white border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
              <div className="text-xs text-muted">Переслано в среднем</div>
              <div className="font-serif text-[26px] font-semibold num">{avgShares.toLocaleString("ru-RU")}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
              <div className="text-[15px] font-bold">По дню недели</div>
              <div className="grid grid-cols-[1.3fr_0.7fr_0.8fr_0.8fr_0.8fr] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                <div>День</div>
                <div>Постов</div>
                <div>Охват</div>
                <div>Просмотры</div>
                <div>Переслано</div>
              </div>
              {weekdayRows.map((r) => (
                <div
                  key={r.label}
                  className="grid grid-cols-[1.3fr_0.7fr_0.8fr_0.8fr_0.8fr] gap-2 py-1.5 border-b border-borderSoft text-[13px] items-center"
                >
                  <div>{r.label}</div>
                  <div className="num">{r.count}</div>
                  <div className="num text-muted">{r.reach.toLocaleString("ru-RU")}</div>
                  <div className="num text-muted">{r.views.toLocaleString("ru-RU")}</div>
                  <div className="num text-muted">{r.shares.toLocaleString("ru-RU")}</div>
                </div>
              ))}
            </div>

            <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
              <div className="text-[15px] font-bold">По времени публикации</div>
              {hourRows.length === 0 ? (
                <div className="text-sm text-muted py-4">Нет публикаций с указанным временем</div>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
                    <div>Час</div>
                    <div>Постов</div>
                    <div>Охват</div>
                    <div>Просмотры</div>
                    <div>Переслано</div>
                  </div>
                  <div className="max-h-[280px] overflow-y-auto flex flex-col">
                    {hourRows.map((r) => (
                      <div
                        key={r.hour}
                        className="grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr] gap-2 py-1.5 border-b border-borderSoft text-[13px] items-center"
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
              )}
            </div>
          </div>

          <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">По типу</div>
            <div className="grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr_1fr] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
              <div>Тип</div>
              <div>Постов</div>
              <div>Охват</div>
              <div>Просмотры</div>
              <div>Переслано</div>
              <div>Реакции</div>
            </div>
            {typeRows.map((r) => (
              <div
                key={r.type}
                className="grid grid-cols-[1fr_0.8fr_1fr_1fr_1fr_1fr] gap-2 py-1.5 border-b border-borderSoft text-[13px] items-center"
              >
                <div className="font-semibold">{POST_TYPE_LABEL[r.type]}</div>
                <div className="num">{r.count}</div>
                <div className="num text-muted">{r.reach.toLocaleString("ru-RU")}</div>
                <div className="num text-muted">{r.views.toLocaleString("ru-RU")}</div>
                <div className="num text-muted">{r.shares.toLocaleString("ru-RU")}</div>
                <div className="num text-muted">{r.reactions.toLocaleString("ru-RU")}</div>
              </div>
            ))}
          </div>

          <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">Все публикации периода</div>
            {entries.length === 0 ? (
              <div className="text-sm text-muted py-4">Нет публикаций за выбранный период</div>
            ) : (
              <div className="max-h-[520px] overflow-auto rounded-md">
                <div className="min-w-[1320px]">
                  <div className="sticky top-0 z-10 bg-white grid grid-cols-[60px_54px_96px_56px_78px_110px_68px_80px_58px_74px_78px_1fr_56px] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
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
                  {entries.map((e) => {
                    const jsDay = new Date(`${e.entry_date}T00:00:00`).getDay();
                    const weekdayLabel = WEEKDAY_LABELS[WEEKDAY_JS_ORDER.indexOf(jsDay)];
                    return (
                      <div
                        key={e.id}
                        className="grid grid-cols-[60px_54px_96px_56px_78px_110px_68px_80px_58px_74px_78px_1fr_56px] gap-2 items-center py-1.5 border-b border-[#F6F3EC] text-[12.5px]"
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
            )}
          </div>
        </>
      )}
    </>
  );
}
