import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { fetchCompetitorPosts } from "@/lib/competitorPosts";
import { getErrorMessage } from "@/lib/errors";

// Публикации конкурентов берутся у Meta (lib/competitorPosts.ts) — бесплатно, по одному запросу на аккаунт.
// results_per_competitor редактируется на странице «Аналитика конкурентов»; это значение только на случай, если настройки нет.
const DEFAULT_RESULTS_PER_COMPETITOR = 6;

async function runSync() {
  const { data: settings } = await supabaseAdmin
    .from("competitor_sync_settings")
    .select("enabled, results_per_competitor")
    .eq("id", 1)
    .maybeSingle();
  if (settings && !settings.enabled) {
    return { skipped: true, reason: "disabled", competitors: 0, posts: 0, upserted: 0 };
  }
  const resultsPerCompetitor = settings?.results_per_competitor ?? DEFAULT_RESULTS_PER_COMPETITOR;

  const { data: competitors, error } = await supabaseAdmin
    .from("tracked_competitors")
    .select("id, handle")
    .eq("platform", "instagram")
    .eq("active", true);
  if (error) throw error;
  if (!competitors || competitors.length === 0) {
    return { competitors: 0, posts: 0, upserted: 0 };
  }

  let posts = 0;
  let upserted = 0;
  const failedHandles: string[] = [];
  for (const c of competitors) {
    try {
      const list = await fetchCompetitorPosts(c.handle, resultsPerCompetitor);
      posts += list.length;
      for (const p of list) {
        const { error: upsertError } = await supabaseAdmin.from("competitor_content").upsert(
          {
            competitor_id: c.id,
            platform: "instagram",
            post_url: p.url,
            posted_at: p.timestamp,
            caption: p.caption,
            media_type: p.type,
            thumbnail_url: p.thumbnail,
            likes: p.likes,
            comments: p.comments,
            shares: 0, // Instagram не отдаёт число репостов
            views: p.views, // 0 у фото и каруселей — у Instagram для них просмотров нет
            synced_at: new Date().toISOString(),
          },
          { onConflict: "platform,post_url" }
        );
        if (upsertError) throw upsertError;
        upserted++;
      }
    } catch (e) {
      failedHandles.push(`${c.handle}: ${getErrorMessage(e).slice(0, 120)}`); // один недоступный аккаунт не должен останавливать остальных
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // если не получилось ни у кого — это сбой, а не «недоступные аккаунты»
  if (failedHandles.length === competitors.length) throw new Error(`Meta не отдала данные ни по одному аккаунту. ${failedHandles[0]}`);
  return { competitors: competitors.length, posts, upserted, failedHandles };
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
    const message = getErrorMessage(e);
    await supabaseAdmin.from("notifications").insert({ type: "sync_error", message: `Синхронизация конкурентов не удалась: ${message}` });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
