// Истории: Instagram отдаёт только активные (24 часа), поэтому раз в час забираем их с цифрами и обложкой в свою базу (smm_story_log).
// Из базы потом собираем «первая и последняя история за период».
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { CITIES, CITY_KEYS, type CityKey } from "@/lib/smm/config";
import { listLiveStories, type LiveStory } from "@/lib/smm/meta";
import { codeFromPeriod, periodLabel, periodUtc, type Period } from "@/lib/smm/periods";
import { escapeHtml } from "@/lib/telegram";

const NL = String.fromCharCode(10);
const BUCKET = "smm-stories";

type Row = {
  story_id: string;
  city: string;
  media_type: string | null;
  permalink: string | null;
  cover_path: string | null;
  posted_at: string;
  views: number;
  reach: number;
  replies: number;
  navigation: number;
  shares: number;
  interactions: number;
};

async function saveCover(city: CityKey, s: LiveStory): Promise<string | null> {
  if (!s.cover) return null;
  try {
    const res = await fetch(s.cover, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const path = `${city}/${s.id}.jpg`;
    const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, Buffer.from(await res.arrayBuffer()), { contentType: "image/jpeg", upsert: true });
    return error ? null : path;
  } catch {
    return null;
  }
}

// Забирает активные истории обоих городов и обновляет базу; цифры только растут (если Instagram временно вернул нули — остаются прежние).
export async function syncStories(): Promise<{ city: string; seen: number; added: number }[]> {
  const out: { city: string; seen: number; added: number }[] = [];
  for (const city of CITY_KEYS) {
    const live = await listLiveStories(city);
    if (live.length === 0) {
      out.push({ city, seen: 0, added: 0 });
      continue;
    }
    const { data, error } = await supabaseAdmin.from("smm_story_log").select("*").in("story_id", live.map((s) => s.id));
    if (error) throw error;
    const known = new Map(((data ?? []) as Row[]).map((r) => [r.story_id, r]));
    let added = 0;
    for (const s of live) {
      const old = known.get(s.id);
      if (!old) added++;
      const cover = old?.cover_path ?? (await saveCover(city, s));
      const { error: upError } = await supabaseAdmin.from("smm_story_log").upsert(
        {
          story_id: s.id,
          city,
          media_type: s.mediaType,
          permalink: s.permalink,
          cover_path: cover,
          posted_at: s.postedAt,
          views: Math.max(s.views, old?.views ?? 0),
          reach: Math.max(s.reach, old?.reach ?? 0),
          replies: Math.max(s.replies, old?.replies ?? 0),
          navigation: Math.max(s.navigation, old?.navigation ?? 0),
          shares: Math.max(s.shares, old?.shares ?? 0),
          interactions: Math.max(s.interactions, old?.interactions ?? 0),
          last_seen: new Date().toISOString(),
        },
        { onConflict: "story_id" }
      );
      if (upError) throw upError;
    }
    out.push({ city, seen: live.length, added });
  }
  return out;
}

const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");
function almatyStamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 5 * 3600000).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`;
}

export type StoryMessage = { photo: string | null; caption: string; markup?: Record<string, unknown> };

function coverUrl(path: string | null): string | null {
  return path ? supabaseAdmin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null;
}

function caption(title: string, city: CityKey, r: Row, now: Date): string {
  const hours = (now.getTime() - new Date(r.posted_at).getTime()) / 3600000;
  const live = hours < 24;
  const link = live && r.permalink ? `\n<a href="${escapeHtml(r.permalink)}">Открыть историю</a>` : "";
  const state = live ? `\n⏳ История висит ${Math.max(1, Math.floor(hours))} ч и ещё не закончилась — цифры пока неполные.` : "";
  return (
    `🎞 <b>${title} · ${CITIES[city].title}</b>\nОпубликована ${almatyStamp(r.posted_at)}${state}\n\n` +
    `👁 Просмотры: <b>${fmt(r.views)}</b> · 🎯 Охват: ${fmt(r.reach)}\n💬 Ответы: ${fmt(r.replies)} · ↗️ Репосты: ${fmt(r.shares)}${link}`
  );
}

// Истории города за период: сводка, первая и последняя (если одна — только она).
export async function storiesMessages(city: CityKey, p: Period, now = new Date()): Promise<StoryMessage[]> {
  const { fromIso, toIso } = periodUtc(p);
  const { data, error } = await supabaseAdmin.from("smm_story_log").select("*").eq("city", city).gte("posted_at", fromIso).lt("posted_at", toIso).order("posted_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const head = `🎞 <b>Истории · ${CITIES[city].title}</b>\n${periodLabel(p)}`;
  if (rows.length === 0) return [{ photo: null, caption: `${head}\nИсторий за этот период в базе нет (бот копит их с момента запуска, старые Instagram не отдаёт).` }];
  const totalViews = rows.reduce((a, r) => a + r.views, 0);
  const listButton = { inline_keyboard: [[{ text: "📃 Список историй", callback_data: `sl|${city === "aktau" ? "a" : "b"}|${codeFromPeriod(p)}` }]] };
  const out: StoryMessage[] = [{ photo: null, caption: `${head}\nИсторий: ${rows.length} · всего просмотров: <b>${fmt(totalViews)}</b>`, markup: listButton }];
  if (rows.length === 1) {
    out.push({ photo: coverUrl(rows[0].cover_path), caption: caption("Единственная история", city, rows[0], now) });
  } else {
    out.push({ photo: coverUrl(rows[0].cover_path), caption: caption("Первая история", city, rows[0], now) });
    out.push({ photo: coverUrl(rows[rows.length - 1].cover_path), caption: caption("Последняя история", city, rows[rows.length - 1], now) });
  }
  return out;
}

// Список всех историй периода по порядку публикации: просмотры каждой и сколько это от первой — видно, как просаживаются просмотры.
export async function storiesList(city: CityKey, p: Period, now = new Date()): Promise<string> {
  const { fromIso, toIso } = periodUtc(p);
  const { data, error } = await supabaseAdmin.from("smm_story_log").select("*").eq("city", city).gte("posted_at", fromIso).lt("posted_at", toIso).order("posted_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const head = `📃 <b>Список историй · ${CITIES[city].title}</b>${NL}${periodLabel(p)}`;
  if (rows.length === 0) return `${head}${NL}Историй за этот период в базе нет.`;
  const first = rows[0].views;
  const lines = rows.map((r, i) => {
    const live = now.getTime() - new Date(r.posted_at).getTime() < 24 * 3600000;
    const share = i === 0 || first <= 0 ? "" : ` · ${Math.round((r.views / first) * 100)}% от первой`;
    return `${i + 1}. ${almatyStamp(r.posted_at).slice(6)} · 👁 <b>${fmt(r.views)}</b>${share} · 🎯 ${fmt(r.reach)}${live ? " ⏳" : ""}`;
  });
  const note = rows.some((r) => now.getTime() - new Date(r.posted_at).getTime() < 24 * 3600000) ? `${NL}${NL}⏳ — история ещё не закончилась, просмотры ещё растут.` : "";
  return `${head}${NL}Всего: ${rows.length} · просмотров ${fmt(rows.reduce((a, r) => a + r.views, 0))}${NL}${NL}${lines.join(NL)}${note}`;
}
