import { NextResponse } from "next/server";
import { requireSectionAccess } from "@/lib/requireAdmin";

// Full-resolution product photos live behind a МойСклад download link that
// needs our API token (confirmed live: 401 without it) — this proxies that
// one request server-side so the token never reaches the browser. Only the
// miniature (moysklad_products.image_url) is safe to use directly as
// <img src>; this route is for the "open full photo" lightbox.
export async function GET(request: Request) {
  const caller = await requireSectionAccess(request, "warehouse.stock", "view");
  if (!caller) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const href = new URL(request.url).searchParams.get("href") ?? "";
  if (!href.startsWith("https://api.moysklad.ru/api/remap/1.2/download/")) {
    return NextResponse.json({ error: "Invalid href" }, { status: 400 });
  }

  const token = process.env.MOYSKLAD_API_TOKEN;
  const upstream = await fetch(href, { headers: { Authorization: `Bearer ${token}` } });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Upstream fetch failed" }, { status: 502 });
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
