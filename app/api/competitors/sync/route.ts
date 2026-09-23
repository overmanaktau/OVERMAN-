import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { fetchInstagramPosts } from "@/lib/apify";

// Cost is per post scraped (~$0.0023 each on the Starter plan) — this caps
// it at roughly $0.0023 * RESULTS_PER_COMPETITOR * competitor count * 30
// days/month. At 30 competitors this is ~$12/month; raising it scales
// linearly, so check the budget before bumping it.
const RESULTS_PER_COMPETITOR = 6;

async function runSync() {
  const { data: competitors, error } = await supabaseAdmin
    .from("tracked_competitors")
    .select("id, handle")
    .eq("platform", "instagram");
  if (error) throw error;
  if (!competitors || competitors.length === 0) {
    return { competitors: 0, posts: 0, upserted: 0 };
  }

  const byHandle = new Map(competitors.map((c) => [c.handle.toLowerCase(), c.id]));
  const posts = await fetchInstagramPosts(competitors.map((c) => c.handle), RESULTS_PER_COMPETITOR);

  let upserted = 0;
  const skippedHandles = new Set<string>();
  for (const p of posts) {
    const owner = (p.ownerUsername ?? "").toLowerCase();
    const competitorId = byHandle.get(owner);
    if (!competitorId || !p.url) {
      if (owner) skippedHandles.add(owner);
      continue;
    }

    const { error: upsertError } = await supabaseAdmin.from("competitor_content").upsert(
      {
        competitor_id: competitorId,
        platform: "instagram",
        post_url: p.url,
        posted_at: p.timestamp,
        caption: p.caption ?? null,
        media_type: p.type ?? null,
        thumbnail_url: p.displayUrl ?? null,
        likes: p.likesCount ?? 0,
        comments: p.commentsCount ?? 0,
        shares: 0, // Instagram never exposes a repost/share count publicly
        views: p.videoPlayCount ?? 0, // 0 for photo posts — IG has no view count for those at all
        synced_at: new Date().toISOString(),
      },
      { onConflict: "platform,post_url" }
    );
    if (upsertError) throw upsertError;
    upserted++;
  }

  return {
    competitors: competitors.length,
    posts: posts.length,
    upserted,
    skippedHandles: [...skippedHandles],
  };
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") ?? "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    const caller = await requireAdmin(request);
    if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  try {
    const result = await runSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
