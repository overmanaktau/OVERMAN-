import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireAdmin } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { watchTarget } from "@/lib/smm/adsWatch";
import { runMorning } from "@/lib/smm/digest";
import { syncStories } from "@/lib/smm/stories";
import { telegramTransport, type ReplyMarkup, type Transport } from "@/lib/smm/telegram";
import type { SmmUser } from "@/lib/smm/users";

export const maxDuration = 300;

// Расписание бота СММ (pg_cron): ?job=ads — слежение за таргетом (каждые 10 минут), ?job=stories — сбор историй (каждый час),
// ?job=morning — утренняя рассылка (9:10 по Алматы; повтор в 9:40 досылает недоставленное).
// Для проверок: ?mock=1 — ничего не отправлять, а вернуть тексты; ?to=<id Telegram> — только этому сотруднику; ?force=1 — игнорировать журнал отправок.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`;
  if (!isCron && !(await requireAdmin(request))) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const job = params.get("job");
  const mock = params.get("mock") === "1";
  const force = params.get("force") === "1";
  const to = params.get("to");

  const sent: { chat: number; kind: string; text: string; markup?: ReplyMarkup }[] = [];
  const transport: Transport = mock
    ? {
        async send(chat, html, markup) {
          sent.push({ chat, kind: "text", text: html, markup });
          return 1;
        },
        async photo(chat, url, caption, markup) {
          sent.push({ chat, kind: "photo", text: `${caption}\n[фото: ${url.slice(0, 70)}…]`, markup });
          return 1;
        },
        async edit() {},
        async answer() {},
      }
    : telegramTransport;

  try {
    let only: SmmUser[] | undefined;
    if (to) {
      const { data, error } = await supabaseAdmin.from("smm_users").select("*").eq("telegram_user_id", Number(to)).eq("status", "approved");
      if (error) throw error;
      only = (data ?? []) as SmmUser[];
    }
    if (job === "ads") return NextResponse.json({ ok: true, results: await watchTarget(transport, { only }), ...(mock ? { sent } : {}) });
    if (job === "stories") return NextResponse.json({ ok: true, results: await syncStories() });
    if (job === "morning") return NextResponse.json({ ok: true, result: await runMorning(transport, { only, force }), ...(mock ? { sent } : {}) });
    return NextResponse.json({ error: "Укажите job=ads | stories | morning." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e), ...(mock ? { sent } : {}) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
