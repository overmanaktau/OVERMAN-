// Server-only client for Apify. Never import from client components —
// APIFY_API_TOKEN must stay server-side.
const APIFY_BASE = "https://api.apify.com/v2";

function getApifyToken(): string {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN не задан.");
  return token;
}

export type InstagramPost = {
  url: string;
  caption?: string;
  timestamp: string;
  type?: string; // "Video" | "Image" | "Sidecar"
  likesCount?: number;
  commentsCount?: number;
  videoPlayCount?: number;
  displayUrl?: string;
  ownerUsername?: string;
};

// One call covers every tracked competitor at once (Apify's actor accepts a
// list of usernames) — cheap (~$0.0023/post, no per-run minimum, unlike
// TikTok's scraper), so there's no reason to call it per-competitor.
// dataDetailLevel: "detailedData" is what gets videoPlayCount (Reel views) —
// Instagram never exposes a view count for plain photo posts at all.
export async function fetchInstagramPosts(usernames: string[], resultsLimit = 20): Promise<InstagramPost[]> {
  if (usernames.length === 0) return [];
  const res = await fetch(
    `${APIFY_BASE}/acts/apify~instagram-post-scraper/run-sync-get-dataset-items?token=${getApifyToken()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernames,
        resultsLimit,
        dataDetailLevel: "detailedData",
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Apify API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}
