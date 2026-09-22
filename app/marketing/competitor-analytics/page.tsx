"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabaseClient";
import { getErrorMessage } from "@/lib/errors";

type Competitor = {
  id: number;
  platform: "instagram" | "tiktok";
  handle: string;
  display_name: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
};

const PLATFORM_LABEL: Record<Competitor["platform"], string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
};

export default function CompetitorAnalyticsPage() {
  const { isAdmin, permissions, fullName, email } = useAuth();
  const canView = isAdmin || permissions["marketing.competitor_analytics"].canView;
  const canEdit = isAdmin || permissions["marketing.competitor_analytics"].canEdit;

  const [tab, setTab] = useState<"competitors" | "top" | "ads">("competitors");

  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newPlatform, setNewPlatform] = useState<Competitor["platform"]>("instagram");
  const [newHandle, setNewHandle] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from("tracked_competitors")
        .select("*")
        .order("platform")
        .order("handle");
      if (error) throw error;
      setCompetitors((data ?? []) as Competitor[]);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const handle = newHandle.trim().replace(/^@/, "");
    if (!handle) return;
    setAdding(true);
    setError(null);
    try {
      const { error } = await supabase.from("tracked_competitors").insert({
        platform: newPlatform,
        handle,
        display_name: newDisplayName.trim() || null,
        created_by_name: fullName || email,
      });
      if (error) throw error;
      setNewHandle("");
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
    } catch (e) {
      setError(getErrorMessage(e));
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
        {(["competitors", "top", "ads"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`text-[13px] rounded-md px-3.5 py-2 ${
              tab === t ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {t === "competitors" ? "Конкуренты" : t === "top" ? "Топ контента" : "Реклама"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-muted">Загрузка…</div>
      ) : tab === "competitors" ? (
        <div className="flex flex-col gap-4">
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
                          className="grid grid-cols-[1fr_1fr_auto] gap-3 items-center py-2 border-b border-borderSoft text-[13px]"
                        >
                          <div className="font-semibold">@{c.handle}</div>
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
                  placeholder="Никнейм, например overman_kz"
                  value={newHandle}
                  onChange={(e) => setNewHandle(e.target.value)}
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
        <div className="bg-surface border border-border rounded-card p-8 max-w-xl">
          <p className="text-sm text-muted">
            Здесь появится топ постов и Reels отслеживаемых конкурентов по вовлечённости (лайки,
            комментарии, репосты, просмотры) — после подключения источника данных (Apify).
          </p>
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
