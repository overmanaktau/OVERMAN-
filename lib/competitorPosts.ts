// Публикации конкурентов в Instagram через официальный доступ Meta («Business Discovery»): через наш бизнес-аккаунт читаются публичные данные чужих
// бизнес-аккаунтов и аккаунтов авторов — подписчики, последние публикации, лайки, комментарии, просмотры видео. Бесплатно, токен тот же (META_ACCESS_TOKEN).
// Ограничения Meta: лайки у аккаунтов со скрытыми лайками приходят пустыми (считаем 0); просмотров у фото и каруселей нет.
import { graph } from "@/lib/smm/meta";

const OUR_IG_ID = "17841475959353007"; // наш Instagram (Актау), от его имени идут запросы

export type CompetitorPost = {
  url: string;
  caption: string | null;
  timestamp: string;
  type: string; // Video | Image | Sidecar — как раньше хранилось в competitor_content.media_type
  likes: number;
  comments: number;
  views: number;
  thumbnail: string | null;
};

type RawMedia = { permalink?: string; caption?: string; media_type?: string; timestamp?: string; like_count?: number; comments_count?: number; view_count?: number; thumbnail_url?: string; media_url?: string };
const TYPE: Record<string, string> = { VIDEO: "Video", IMAGE: "Image", CAROUSEL_ALBUM: "Sidecar" };

// Последние публикации одного аккаунта; недоступный аккаунт (личный, закрытый, переименован) — ошибка с причиной.
export async function fetchCompetitorPosts(handle: string, limit: number): Promise<CompetitorPost[]> {
  const fields = `business_discovery.username(${handle}){media.limit(${limit}){permalink,caption,media_type,timestamp,like_count,comments_count,view_count,thumbnail_url,media_url}}`;
  const res = await graph<{ business_discovery?: { media?: { data?: RawMedia[] } } }>(`/${OUR_IG_ID}`, { fields });
  return (res.business_discovery?.media?.data ?? [])
    .filter((m) => m.permalink && m.timestamp)
    .map((m) => ({
      url: m.permalink as string,
      caption: m.caption ?? null,
      timestamp: m.timestamp as string,
      type: TYPE[m.media_type ?? ""] ?? "Image",
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
      views: m.view_count ?? 0,
      thumbnail: m.thumbnail_url ?? m.media_url ?? null,
    }));
}
