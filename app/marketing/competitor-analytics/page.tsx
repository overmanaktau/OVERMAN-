"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

type Competitor = {
  id: number;
  platform: "instagram" | "tiktok";
  handle: string;
  profile_url: string | null;
  display_name: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  active: boolean;
};

const PLATFORM_LABEL: Record<Competitor["platform"], string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
};

// Ссылка на профиль однозначнее ника — форматы отличаются на платформах,
// в ней легко опечататься. Ник всё равно парсим из неё — на нём завязан
// unique(platform, handle), и он удобнее для отображения ("@ник").
function parseHandleFromProfileUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const path = new URL(withProtocol).pathname.replace(/^\/+|\/+$/g, "");
    const first = path.split("/")[0];
    return first ? first.replace(/^@/, "") : null;
  } catch {
    return null;
  }
}

function competitorProfileUrl(c: Competitor): string {
  if (c.profile_url) return c.profile_url;
  return c.platform === "instagram" ? `https://instagram.com/${c.handle}` : `https://www.tiktok.com/@${c.handle}`;
}

type ContentItem = {
  id: number;
  platform: "instagram" | "tiktok";
  post_url: string;
  posted_at: string;
  caption: string | null;
  media_type: string | null;
  thumbnail_url: string | null;
  likes: number;
  comments: number;
  shares: number;
  views: number;
  tracked_competitors: { platform: string; handle: string; display_name: string | null } | null;
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
function parseYmd(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

const TOP_PERIODS = [
  { key: "yesterday", label: "Вчера", noun: "за вчера" },
  { key: "3d", label: "3 дня", noun: "за 3 дня" },
  { key: "7d", label: "7 дней", noun: "за 7 дней" },
  { key: "10d", label: "10 дней", noun: "за 10 дней" },
  { key: "month", label: "За этот месяц", noun: "за этот месяц" },
] as const;
type TopPeriod = (typeof TOP_PERIODS)[number]["key"];

function getTopPeriodRange(key: TopPeriod, today: Date): { start: Date; end: Date } {
  const d = stripTime(today);
  if (key === "yesterday") {
    const y = addDays(d, -1);
    return { start: y, end: y };
  }
  if (key === "3d") return { start: addDays(d, -2), end: d };
  if (key === "7d") return { start: addDays(d, -6), end: d };
  if (key === "10d") return { start: addDays(d, -9), end: d };
  return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: d }; // За этот месяц
}

const TOP_LIMITS = [
  { key: 3, label: "Топ 3" },
  { key: 5, label: "Топ 5" },
  { key: 10, label: "Топ 10" },
  { key: null, label: "Все" },
] as const;
type TopLimit = (typeof TOP_LIMITS)[number]["key"];

const SORT_OPTIONS = [
  { key: "engagement", label: "По вовлечённости" },
  { key: "likes", label: "По лайкам" },
  { key: "views", label: "По просмотрам" },
  { key: "comments", label: "По комментариям" },
  { key: "shares", label: "По репостам" },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]["key"];

// "Вовлечённость" — доля аудитории, реально провзаимодействовавшей с постом
// (лайки+комментарии+репосты относительно охвата), а не просто сумма счётчиков,
// которую иначе полностью забивают просмотры (они на порядки больше остального).
function engagementRate(item: ContentItem): number {
  return item.views > 0 ? ((item.likes + item.comments + item.shares) / item.views) * 100 : 0;
}

function engagementScore(item: ContentItem, sortKey: SortKey): number {
  if (sortKey === "likes") return item.likes;
  if (sortKey === "views") return item.views;
  if (sortKey === "comments") return item.comments;
  if (sortKey === "shares") return item.shares;
  return engagementRate(item);
}

export default function CompetitorAnalyticsPage() {
  const { isAdmin, permissions, fullName, email } = useAuth();
  const canView = isAdmin || permissions["marketing.competitor_analytics"].canView;
  const canEdit = isAdmin || permissions["marketing.competitor_analytics"].canEdit;

  const [tab, setTab] = useState<"competitors" | "top" | "ads">("top");

  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newPlatform, setNewPlatform] = useState<Competitor["platform"]>("instagram");
  const [newProfileUrl, setNewProfileUrl] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [adding, setAdding] = useState(false);

  const [syncEnabled, setSyncEnabled] = useState(true);
  const [savedSyncEnabled, setSavedSyncEnabled] = useState(true);
  const [resultsPerCompetitor, setResultsPerCompetitor] = useState(6);
  const [savedResultsPerCompetitor, setSavedResultsPerCompetitor] = useState(6);
  const [savedActiveById, setSavedActiveById] = useState<Map<number, boolean>>(new Map());
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [justSavedSettings, setJustSavedSettings] = useState(false);

  const [topPeriod, setTopPeriod] = useState<TopPeriod>("7d");
  const [activeCustomTop, setActiveCustomTop] = useState<{ start: string; end: string } | null>(null);
  const [showTopCustomPicker, setShowTopCustomPicker] = useState(false);
  const [topCustomStart, setTopCustomStart] = useState("");
  const [topCustomEnd, setTopCustomEnd] = useState("");
  const topCustomPickerRef = useRef<HTMLDivElement>(null);

  const [sortKey, setSortKey] = useState<SortKey>("engagement");
  const [showOutsiders, setShowOutsiders] = useState(false);
  const [topLimit, setTopLimit] = useState<TopLimit>(10);

  const [topContent, setTopContent] = useState<ContentItem[]>([]);
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [competitorsRes, settingsRes] = await Promise.all([
        supabase.from("tracked_competitors").select("*").order("platform").order("handle"),
        supabase
          .from("competitor_sync_settings")
          .select("enabled, results_per_competitor")
          .eq("id", 1)
          .maybeSingle(),
      ]);
      if (competitorsRes.error) throw competitorsRes.error;
      if (settingsRes.error) throw settingsRes.error;
      const rows = (competitorsRes.data ?? []) as Competitor[];
      setCompetitors(rows);
      setSavedActiveById(new Map(rows.map((c) => [c.id, c.active])));
      const enabled = settingsRes.data?.enabled ?? true;
      setSyncEnabled(enabled);
      setSavedSyncEnabled(enabled);
      const results = settingsRes.data?.results_per_competitor ?? 6;
      setResultsPerCompetitor(results);
      setSavedResultsPerCompetitor(results);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadTopContent = useCallback(async (start: Date, end: Date) => {
    setTopLoading(true);
    setTopError(null);
    try {
      const { data, error } = await supabase
        .from("competitor_content")
        .select("*, tracked_competitors(platform, handle, display_name)")
        .gte("posted_at", start.toISOString())
        .lt("posted_at", addDays(end, 1).toISOString())
        .order("posted_at", { ascending: false });
      if (error) throw error;
      setTopContent((data ?? []) as ContentItem[]);
    } catch (e) {
      setTopError(getErrorMessage(e));
    } finally {
      setTopLoading(false);
    }
  }, []);

  const topRange = useMemo(
    () =>
      activeCustomTop
        ? { start: parseYmd(activeCustomTop.start), end: parseYmd(activeCustomTop.end) }
        : getTopPeriodRange(topPeriod, new Date()),
    [topPeriod, activeCustomTop]
  );

  useEffect(() => {
    if (tab === "top") loadTopContent(topRange.start, topRange.end);
  }, [tab, topRange, loadTopContent]);

  useEffect(() => {
    if (!showTopCustomPicker) return;
    function onClick(e: MouseEvent) {
      if (topCustomPickerRef.current && !topCustomPickerRef.current.contains(e.target as Node)) {
        setShowTopCustomPicker(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showTopCustomPicker]);

  function applyTopCustomRange() {
    if (!topCustomStart || !topCustomEnd || topCustomStart > topCustomEnd) return;
    setActiveCustomTop({ start: topCustomStart, end: topCustomEnd });
    setShowTopCustomPicker(false);
  }

  const sortedTopContent = useMemo(() => {
    const sorted = [...topContent].sort((a, b) => engagementScore(b, sortKey) - engagementScore(a, sortKey));
    return showOutsiders ? sorted.reverse() : sorted;
  }, [topContent, sortKey, showOutsiders]);

  const displayedTopContent = topLimit ? sortedTopContent.slice(0, topLimit) : sortedTopContent;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const profileUrl = newProfileUrl.trim();
    if (!profileUrl) return;
    const handle = parseHandleFromProfileUrl(profileUrl);
    if (!handle) {
      setError("Не удалось распознать ник из ссылки — проверьте, что это ссылка на профиль");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const { error } = await supabase.from("tracked_competitors").insert({
        platform: newPlatform,
        handle,
        profile_url: profileUrl.startsWith("http") ? profileUrl : `https://${profileUrl}`,
        display_name: newDisplayName.trim() || null,
        created_by_name: fullName || email,
      });
      if (error) throw error;
      setNewProfileUrl("");
      setNewDisplayName("");
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Убрать этот аккаунт из отслеживаемых?")) return;
    setError(null);
    try {
      const { error } = await supabase.from("tracked_competitors").delete().eq("id", id);
      if (error) throw error;
      setCompetitors((prev) => prev.filter((c) => c.id !== id));
      setSavedActiveById((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }

  function toggleActive(id: number) {
    setCompetitors((prev) => prev.map((c) => (c.id === id ? { ...c, active: !c.active } : c)));
    setJustSavedSettings(false);
  }

  const competitorsDirty = competitors.some((c) => savedActiveById.get(c.id) !== c.active);
  const settingsDirty = syncEnabled !== savedSyncEnabled || resultsPerCompetitor !== savedResultsPerCompetitor;
  const anySettingsDirty = competitorsDirty || settingsDirty;

  async function handleSaveSettings() {
    setSavingSettings(true);
    setSettingsError(null);
    try {
      if (settingsDirty) {
        const { error } = await supabase
          .from("competitor_sync_settings")
          .update({
            enabled: syncEnabled,
            results_per_competitor: resultsPerCompetitor,
            updated_at: new Date().toISOString(),
          })
          .eq("id", 1);
        if (error) throw error;
      }
      const changed = competitors.filter((c) => savedActiveById.get(c.id) !== c.active);
      for (const c of changed) {
        const { error } = await supabase.from("tracked_competitors").update({ active: c.active }).eq("id", c.id);
        if (error) throw error;
      }
      setSavedSyncEnabled(syncEnabled);
      setSavedResultsPerCompetitor(resultsPerCompetitor);
      setSavedActiveById(new Map(competitors.map((c) => [c.id, c.active])));
      setJustSavedSettings(true);
      setTimeout(() => setJustSavedSettings(false), 2000);
    } catch (e) {
      setSettingsError(getErrorMessage(e));
    } finally {
      setSavingSettings(false);
    }
  }

  if (!canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Аналитика конкурентов».</p>
      </div>
    );
  }

  const byPlatform = (p: Competitor["platform"]) => competitors.filter((c) => c.platform === p);

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Маркетинг</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">Аналитика конкурентов</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          Список отслеживаемых конкурентов, топ их контента по вовлечённости и проверка активной
          рекламы — по мере подключения источников данных.
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

      <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit">
        {(["top", "ads", "competitors"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`text-[13px] rounded-md px-3.5 py-2 ${
              tab === t ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {t === "competitors" ? "Внесение конкурентов" : t === "ads" ? "Реклама" : "Топ контента"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : tab === "competitors" ? (
        <div className="flex flex-col gap-4">
          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex flex-col gap-0.5">
                <div className="text-[15px] font-bold">Автосинхронизация контента конкурентов</div>
                <div className="text-xs text-muted max-w-md">
                  Ежедневная выгрузка постов через Apify. Выключение остановит только новые загрузки —
                  уже собранные данные останутся. Отдельного конкурента можно исключить галочкой ниже.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[13px] text-muted">
                  Постов с аккаунта
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={resultsPerCompetitor}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(30, Number(e.target.value) || 1));
                      setResultsPerCompetitor(v);
                      setJustSavedSettings(false);
                    }}
                    className="w-16 border border-border rounded-lg px-2 py-1.5 text-sm text-center disabled:opacity-50"
                  />
                </label>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => {
                    setSyncEnabled((v) => !v);
                    setJustSavedSettings(false);
                  }}
                  className={`text-[13px] font-bold rounded-lg px-4 py-2.5 disabled:opacity-50 ${
                    syncEnabled ? "bg-accent text-paper" : "bg-paper text-muted border border-border"
                  }`}
                >
                  {syncEnabled ? "Включена" : "Выключена"}
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    disabled={!anySettingsDirty || savingSettings}
                    className={`text-[13px] font-bold rounded-lg px-[18px] py-2.5 disabled:opacity-50 ${
                      anySettingsDirty ? "bg-accent text-paper" : "bg-paper text-mutedLight border border-border"
                    }`}
                  >
                    {savingSettings ? "Сохраняем…" : justSavedSettings ? "Сохранено" : "Сохранить"}
                  </button>
                )}
                <a
                  href="https://console.apify.com/billing"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] font-bold rounded-lg px-4 py-2.5 border border-border text-muted hover:text-ink"
                >
                  Оплатить Apify
                </a>
              </div>
            </div>
            {settingsError && <div className="text-sm text-[#A34B36]">{settingsError}</div>}
          </div>

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">Отслеживаемые аккаунты</div>
            {competitors.length === 0 ? (
              <div className="text-sm text-muted py-4">
                Список пуст — добавьте конкурентов формой ниже.
              </div>
            ) : (
              (["instagram", "tiktok"] as const).map((platform) => {
                const rows = byPlatform(platform);
                if (rows.length === 0) return null;
                return (
                  <div key={platform} className="flex flex-col gap-2">
                    <div className="text-[11px] uppercase tracking-wide text-mutedLight">
                      {PLATFORM_LABEL[platform]}
                    </div>
                    <div className="flex flex-col">
                      {rows.map((c) => (
                        <div
                          key={c.id}
                          className={`grid grid-cols-[auto_1fr_1fr_auto] gap-3 items-center py-2 border-b border-borderSoft text-[13px] ${
                            c.active ? "" : "opacity-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={c.active}
                            disabled={!canEdit}
                            onChange={() => toggleActive(c.id)}
                            title={c.active ? "Отключить синхронизацию для этого конкурента" : "Включить синхронизацию для этого конкурента"}
                            className="w-4 h-4 accent-accent"
                          />
                          <a
                            href={competitorProfileUrl(c)}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold hover:underline"
                          >
                            @{c.handle}
                          </a>
                          <div className="text-muted">{c.display_name || "—"}</div>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => handleDelete(c.id)}
                              className="text-[#A34B36] font-semibold text-left"
                            >
                              Удалить
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {canEdit && (
            <form
              onSubmit={handleAdd}
              className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5"
            >
              <div className="text-[15px] font-bold">Добавить конкурента</div>
              <div className="grid grid-cols-[140px_1fr_1fr] gap-3">
                <select
                  value={newPlatform}
                  onChange={(e) => setNewPlatform(e.target.value as Competitor["platform"])}
                  className="border border-border rounded-lg px-3 py-2.5 text-sm"
                >
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                </select>
                <input
                  type="text"
                  required
                  placeholder="Ссылка на профиль, например instagram.com/overman_kz"
                  value={newProfileUrl}
                  onChange={(e) => setNewProfileUrl(e.target.value)}
                  className="border border-border rounded-lg px-3 py-2.5 text-sm"
                />
                <input
                  type="text"
                  placeholder="Название (необязательно)"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  className="border border-border rounded-lg px-3 py-2.5 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={adding}
                className="self-start text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
              >
                {adding ? "Добавляем…" : "Добавить"}
              </button>
            </form>
          )}
        </div>
      ) : tab === "top" ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit relative">
            {TOP_PERIODS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTopPeriod(key);
                  setActiveCustomTop(null);
                }}
                className={`text-[13px] rounded-md px-3.5 py-2 ${
                  topPeriod === key && !activeCustomTop ? "bg-accent text-paper font-bold" : "text-muted font-medium"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="w-px h-5 bg-border mx-0.5" />
            <div ref={topCustomPickerRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  if (!showTopCustomPicker) {
                    setTopCustomStart(activeCustomTop?.start ?? ymd(addDays(new Date(), -6)));
                    setTopCustomEnd(activeCustomTop?.end ?? ymd(new Date()));
                  }
                  setShowTopCustomPicker((v) => !v);
                }}
                className={`text-[13px] rounded-md px-3.5 py-2 ${
                  activeCustomTop ? "bg-accent text-paper font-bold" : "text-muted font-medium"
                }`}
              >
                {activeCustomTop ? `${activeCustomTop.start} — ${activeCustomTop.end}` : "Свой период"}
              </button>
              {showTopCustomPicker && (
                <div className="absolute right-0 top-full mt-2 z-50 bg-surface border border-border rounded-lg shadow-lg p-3.5 flex flex-col gap-2.5 w-[230px]">
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    С
                    <input
                      type="date"
                      value={topCustomStart}
                      max={topCustomEnd || undefined}
                      onChange={(e) => setTopCustomStart(e.target.value)}
                      className="border border-border rounded-md px-2 py-1.5 text-[13px] bg-paper text-ink"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    По
                    <input
                      type="date"
                      value={topCustomEnd}
                      min={topCustomStart || undefined}
                      onChange={(e) => setTopCustomEnd(e.target.value)}
                      className="border border-border rounded-md px-2 py-1.5 text-[13px] bg-paper text-ink"
                    />
                  </label>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowTopCustomPicker(false)}
                      className="text-[12.5px] font-semibold text-muted px-2.5 py-1.5 rounded-md hover:bg-paper"
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      onClick={applyTopCustomRange}
                      disabled={!topCustomStart || !topCustomEnd || topCustomStart > topCustomEnd}
                      className="text-[12.5px] font-bold text-paper bg-accent rounded-md px-3 py-1.5 disabled:opacity-50"
                    >
                      Применить
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit">
              {SORT_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSortKey(key)}
                  className={`text-[13px] rounded-md px-3 py-2 ${
                    sortKey === key ? "bg-accent text-paper font-bold" : "text-muted font-medium"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit">
                {TOP_LIMITS.map(({ key, label }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setTopLimit(key)}
                    className={`text-[13px] rounded-md px-3 py-2 ${
                      topLimit === key ? "bg-accent text-paper font-bold" : "text-muted font-medium"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit">
                {([
                  [false, "Лидеры"],
                  [true, "Аутсайдеры"],
                ] as const).map(([val, label]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setShowOutsiders(val)}
                    className={`text-[13px] rounded-md px-3.5 py-2 ${
                      showOutsiders === val ? "bg-accent text-paper font-bold" : "text-muted font-medium"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {topError && (
            <div className="flex items-center gap-3 text-sm text-[#A34B36]">
              <span>{topError}</span>
              <button
                type="button"
                onClick={() => loadTopContent(topRange.start, topRange.end)}
                className="font-semibold underline"
              >
                Повторить
              </button>
            </div>
          )}

          <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
            <div className="text-[15px] font-bold">
              {topLimit ? `Топ ${topLimit}` : showOutsiders ? "Аутсайдеры" : "Топ контента"}{" "}
              {activeCustomTop
                ? `за период ${activeCustomTop.start} — ${activeCustomTop.end}`
                : TOP_PERIODS.find((p) => p.key === topPeriod)?.noun}{" "}
              · {SORT_OPTIONS.find((o) => o.key === sortKey)?.label.toLowerCase()}
              {topLimit && showOutsiders ? " · аутсайдеры" : ""}
            </div>
            {topLoading ? (
              <div className="text-sm text-muted py-4">Загрузка…</div>
            ) : displayedTopContent.length === 0 ? (
              <div className="text-sm text-muted py-4">
                Нет данных за этот период — контент отслеживаемых конкурентов ещё не синхронизирован
                (нужен источник данных, например Apify).
              </div>
            ) : (
              <div className="flex flex-col">
                {displayedTopContent.map((item, i) => {
                  const rate = item.views > 0 ? engagementRate(item) : null;
                  const likeConversion = item.views > 0 ? (item.likes / item.views) * 100 : null;
                  return (
                    <div
                      key={item.id}
                      className="grid grid-cols-[auto_1fr_auto] gap-3 items-center py-3 border-b border-borderSoft text-[13px]"
                    >
                      <div className="text-mutedLight font-semibold w-5">{i + 1}</div>
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <a
                          href={item.post_url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold truncate hover:underline"
                        >
                          @{item.tracked_competitors?.handle ?? "—"}
                          {item.tracked_competitors?.display_name
                            ? ` · ${item.tracked_competitors.display_name}`
                            : ""}
                        </a>
                        {item.caption && <div className="text-muted truncate">{item.caption}</div>}
                      </div>
                      <div className="flex flex-col items-end gap-0.5 whitespace-nowrap">
                        <div className="text-muted num">
                          👁 {item.views} · ♥ {item.likes} · 💬 {item.comments} · ✈ {item.shares}
                        </div>
                        {rate !== null && (
                          <div className="text-mutedLight text-[11px] num">
                            Вовлечённость: {rate.toFixed(1)}%
                            {likeConversion !== null && ` · лайки/просмотры: ${likeConversion.toFixed(1)}%`}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-card p-8 max-w-xl">
          <p className="text-sm text-muted">
            Здесь появится проверка через Meta Ad Library — какие креативы конкурент сейчас крутит
            в рекламе Instagram/Facebook.
          </p>
        </div>
      )}
    </>
  );
}
