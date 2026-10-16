// Чтение данных Meta (Instagram и реклама) через Graph API. Токен постоянный (META_ACCESS_TOKEN); бот только читает, ничего не публикует.
import { CITIES, type CityKey } from "@/lib/smm/config";
import { periodUtc, type Period } from "@/lib/smm/periods";

const G = "https://graph.facebook.com/v21.0";
const RETRY_CODES = [1, 2, 4, 17, 32, 613];

function token(): string {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) throw new Error("META_ACCESS_TOKEN не задан.");
  return t;
}

class MetaError extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
  }
}

// Чтение из Graph API; временные сбои и лимиты запросов повторяются, остальное — сразу ошибка.
// path — путь вида «/123/media» или полный адрес следующей страницы (paging.next, токен в нём уже есть).
export async function graph<T = any>(path: string, params: Record<string, string> = {}): Promise<T> {
  const full = path.startsWith("http");
  const url = new URL(full ? path : `${G}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!full) url.searchParams.set("access_token", token());
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.ok && !json.error) return json as T;
      const code = Number(json?.error?.code);
      last = `Meta ${res.status}: ${json?.error?.message ?? "ошибка"} (код ${json?.error?.code ?? "?"})`;
      if (!RETRY_CODES.includes(code) && res.status < 500 && res.status !== 429) throw new MetaError(last, false);
    } catch (e) {
      if (e instanceof MetaError && !e.retry) throw e;
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  throw new Error(last);
}

// ---------- Реклама ----------

export type TargetPost = {
  key: string; // id публикации в Instagram (или ссылка, если id нет)
  permalink: string | null;
  mediaId: string | null;
  campaign: string;
  adIds: string[];
  adNames: string[];
  objectType: string | null;
  thumb: string | null;
};

// Активные объявления кабинета, сгруппированные по публикации (на один пост обычно идёт несколько объявлений).
export async function listTargetPosts(city: CityKey): Promise<TargetPost[]> {
  const posts = new Map<string, TargetPost>();
  let page = await graph<any>(`/${CITIES[city].ad}/ads`, {
    fields: "id,name,effective_status,campaign{name},creative{effective_instagram_media_id,instagram_permalink_url,thumbnail_url,object_type}",
    effective_status: '["ACTIVE"]',
    limit: "100",
  });
  for (let i = 0; i < 10; i++) {
    for (const ad of page.data ?? []) {
      const c = ad.creative ?? {};
      const key = String(c.effective_instagram_media_id ?? c.instagram_permalink_url ?? ad.id);
      const p: TargetPost = posts.get(key) ?? { key, permalink: c.instagram_permalink_url ?? null, mediaId: c.effective_instagram_media_id ?? null, campaign: ad.campaign?.name ?? "", adIds: [], adNames: [], objectType: c.object_type ?? null, thumb: c.thumbnail_url ?? null };
      p.adIds.push(ad.id);
      p.adNames.push(ad.name ?? "");
      posts.set(key, p);
    }
    if (!page.paging?.next) break;
    page = await graph<any>(page.paging.next);
  }
  return [...posts.values()];
}

// Лучшая обложка публикации: из самой публикации в Instagram (крупнее, чем у рекламного креатива).
export async function postCover(p: { mediaId: string | null; thumb: string | null }): Promise<string | null> {
  if (p.mediaId) {
    try {
      const m = await graph<any>(`/${p.mediaId}`, { fields: "media_type,thumbnail_url,media_url" });
      const url = m.thumbnail_url ?? (m.media_type === "IMAGE" ? m.media_url : null);
      if (url) return url as string;
    } catch {
      // берём обложку рекламного креатива
    }
  }
  return p.thumb;
}

export async function adStatuses(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const r = await graph<Record<string, { effective_status?: string }>>("/", { ids: ids.join(","), fields: "effective_status" });
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(r)) out[id] = v.effective_status ?? "";
  return out;
}

export const STATUS_TEXT: Record<string, string> = {
  PAUSED: "приостановлено",
  CAMPAIGN_PAUSED: "кампания приостановлена",
  ADSET_PAUSED: "группа объявлений приостановлена",
  ARCHIVED: "в архиве",
  DELETED: "удалено",
  DISAPPROVED: "отклонено Meta",
  WITH_ISSUES: "есть проблемы",
  PENDING_REVIEW: "на проверке",
  IN_PROCESS: "обрабатывается",
};

export type Spend = { spend: number; impressions: number; clicks: number; reach: number };
export async function adSpend(city: CityKey, p: Period): Promise<Spend> {
  const r = await graph<any>(`/${CITIES[city].ad}/insights`, { time_range: JSON.stringify({ since: p.from, until: p.to }), fields: "spend,impressions,clicks,reach" });
  const d = r.data?.[0] ?? {};
  return { spend: Number(d.spend ?? 0), impressions: Number(d.impressions ?? 0), clicks: Number(d.clicks ?? 0), reach: Number(d.reach ?? 0) };
}

// ---------- Посты ----------

export type Post = {
  id: string;
  type: string; // Reels / Пост / Карусель / Видео
  permalink: string;
  postedAt: string; // ISO
  likes: number;
  comments: number;
  views: number;
  reach: number;
  saved: number;
  shares: number;
  interactions: number;
};

const POST_METRICS = ["views,reach,saved,shares,total_interactions", "reach,saved,shares,total_interactions", "reach,saved,shares"];

async function postInsights(id: string): Promise<Partial<Post>> {
  for (const set of POST_METRICS) {
    try {
      const r = await graph<any>(`/${id}/insights`, { metric: set });
      const v: Record<string, number> = {};
      for (const x of r.data ?? []) v[x.name] = Number(x.values?.[0]?.value ?? 0);
      return { views: v.views ?? 0, reach: v.reach ?? 0, saved: v.saved ?? 0, shares: v.shares ?? 0, interactions: v.total_interactions ?? 0 };
    } catch {
      // у публикации нет этих метрик (например, совсем новая) — пробуем меньший набор
    }
  }
  return {};
}

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const typeText = (t: string, product: string) => (product === "REELS" ? "Reels" : t === "CAROUSEL_ALBUM" ? "Карусель" : t === "VIDEO" ? "Видео" : "Пост");
const isoOf = (ts: string) => new Date(String(ts).replace("+0000", "Z")).toISOString();

// Публикации аккаунта за период (с цифрами по каждой). Не больше 200 штук, чтобы уложиться во время ответа.
export async function listPosts(city: CityKey, p: Period): Promise<{ posts: Post[]; truncated: boolean }> {
  const { fromIso, toIso } = periodUtc(p);
  const raw: any[] = [];
  let page = await graph<any>(`/${CITIES[city].ig}/media`, { fields: "id,media_type,media_product_type,permalink,timestamp,like_count,comments_count", limit: "100" });
  let done = false;
  for (let i = 0; i < 12 && !done; i++) {
    for (const m of page.data ?? []) {
      const t = isoOf(m.timestamp);
      if (t < fromIso) {
        done = true;
        break;
      }
      if (t < toIso) raw.push(m);
    }
    if (done || !page.paging?.next) break;
    page = await graph<any>(page.paging.next);
  }
  const truncated = raw.length > 200;
  const posts = await inBatches(raw.slice(0, 200), 8, async (m): Promise<Post> => {
    const ins = await postInsights(m.id);
    return {
      id: m.id,
      type: typeText(m.media_type, m.media_product_type),
      permalink: m.permalink,
      postedAt: isoOf(m.timestamp),
      likes: Number(m.like_count ?? 0),
      comments: Number(m.comments_count ?? 0),
      views: ins.views ?? 0,
      reach: ins.reach ?? 0,
      saved: ins.saved ?? 0,
      shares: ins.shares ?? 0,
      interactions: ins.interactions ?? 0,
    };
  });
  return { posts, truncated };
}

export type AccountTotals = { followers: number; reach: number | null; views: number; engaged: number; likes: number; comments: number; shares: number; saves: number };
// Итоги аккаунта за период (окна по 30 дней складываются; охват за больше чем 30 дней сложить нельзя — тогда null).
export async function accountTotals(city: CityKey, p: Period): Promise<AccountTotals> {
  const { fromSec, toSec } = periodUtc(p);
  const info = await graph<any>(`/${CITIES[city].ig}`, { fields: "followers_count" });
  const total: AccountTotals = { followers: Number(info.followers_count ?? 0), reach: 0, views: 0, engaged: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
  const WINDOW = 30 * 86400;
  let windows = 0;
  for (let s = fromSec; s < toSec; s += WINDOW) {
    windows++;
    const until = Math.min(s + WINDOW, toSec);
    const r = await graph<any>(`/${CITIES[city].ig}/insights`, { metric: "reach,views,accounts_engaged,likes,comments,shares,saves", period: "day", metric_type: "total_value", since: String(s), until: String(until) });
    const v: Record<string, number> = {};
    for (const x of r.data ?? []) v[x.name] = Number(x.total_value?.value ?? 0);
    total.reach = (total.reach ?? 0) + (v.reach ?? 0);
    total.views += v.views ?? 0;
    total.engaged += v.accounts_engaged ?? 0;
    total.likes += v.likes ?? 0;
    total.comments += v.comments ?? 0;
    total.shares += v.shares ?? 0;
    total.saves += v.saves ?? 0;
  }
  if (windows > 1) total.reach = null;
  return total;
}

// ---------- Истории ----------

export type LiveStory = {
  id: string;
  mediaType: string;
  permalink: string | null;
  postedAt: string;
  cover: string | null;
  views: number;
  reach: number;
  replies: number;
  navigation: number;
  shares: number;
  interactions: number;
};

// Активные сейчас истории (только такие Instagram отдаёт — 24 часа после публикации) с цифрами.
export async function listLiveStories(city: CityKey): Promise<LiveStory[]> {
  const r = await graph<any>(`/${CITIES[city].ig}/stories`, { fields: "id,media_type,media_url,thumbnail_url,permalink,timestamp", limit: "100" });
  const out: LiveStory[] = [];
  for (const s of r.data ?? []) {
    let m = { views: 0, reach: 0, replies: 0, navigation: 0, shares: 0, interactions: 0 };
    try {
      const i = await graph<any>(`/${s.id}/insights`, { metric: "views,reach,replies,navigation,shares,total_interactions" });
      const v: Record<string, number> = {};
      for (const x of i.data ?? []) v[x.name] = Number(x.values?.[0]?.value ?? 0);
      m = { views: v.views ?? 0, reach: v.reach ?? 0, replies: v.replies ?? 0, navigation: v.navigation ?? 0, shares: v.shares ?? 0, interactions: v.total_interactions ?? 0 };
    } catch {
      // слишком мало зрителей для статистики — оставляем нули, в следующий час обновим
    }
    out.push({ id: s.id, mediaType: s.media_type, permalink: s.permalink ?? null, postedAt: isoOf(s.timestamp), cover: s.thumbnail_url ?? (s.media_type === "IMAGE" ? s.media_url : null) ?? null, ...m });
  }
  return out;
}
