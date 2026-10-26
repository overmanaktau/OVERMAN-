import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendCoachDocument } from "@/lib/coach/bot";
import { stable } from "@/lib/reports/stable";
import { activeHoldFor } from "@/lib/verify/holds";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { todayInAlmaty } from "@/lib/coach/metrics";
import { WAREHOUSE_CITY, buildWarehouseOverviewPdf, lastTwoWeeks, loadWarehouseWeek, warehouseFileName } from "@/lib/reports/warehouseOverview";

export const maxDuration = 120;

// PDF «Склад — обзор» за прошлую неделю с разницей от позапрошлой — закупщику бота-помощника, по каждому городу отдельным файлом.
// Только с CRON_SECRET. По понедельникам в 7:00 (pg_cron warehouse-overview-weekly-pdf) с ?send=1.
// ?store=point_1|point_3 — только этот город; ?from=YYYY-MM-DD — понедельник более ранней из двух недель;
// без ?send=1 файл города (?store обязателен) отдаётся в ответ, никому не отправляется.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }
  const url = new URL(request.url);
  const storeParam = url.searchParams.get("store");
  const from = url.searchParams.get("from") ?? undefined;
  const send = url.searchParams.get("send") === "1";
  if ((storeParam && !WAREHOUSE_CITY[storeParam]) || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (!send && !storeParam)) {
    return NextResponse.json({ error: "Неверные параметры." }, { status: 400 });
  }
  const stores = storeParam ? [storeParam] : Object.keys(WAREHOUSE_CITY);
  const [weekA, weekB] = lastTwoWeeks(todayInAlmaty(), from);

  try {
    const files: { store: string; name: string; caption: string; pdf: Uint8Array }[] = [];
    const problems: string[] = [];
    for (const store of stores) {
      const city = WAREHOUSE_CITY[store];
      // Контрольный пересчёт, как у остальных отчётов: два совпадающих подсчёта, иначе не отправляем.
      const checked = await stable(async () => ({ prev: await loadWarehouseWeek(store, weekA.from, weekA.to), cur: await loadWarehouseWeek(store, weekB.from, weekB.to) }), (v) => JSON.stringify(v));
      if (!checked.ok) {
        problems.push(`${city}: контрольный пересчёт — ${checked.reason}`);
        continue;
      }
      const hold = await activeHoldFor([store], { from: weekA.from, to: weekB.to });
      if (hold) {
        problems.push(`${city}: не исправлено расхождение за ${hold.check_date.split("-").reverse().join(".")}`);
        continue;
      }
      const { prev, cur } = checked.value;
      const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
      files.push({
        store,
        name: warehouseFileName(city, weekB),
        caption: `Склад — обзор · ${city}: ${dm(weekB.from)}–${dm(weekB.to)} к ${dm(weekA.from)}–${dm(weekA.to)}`,
        pdf: await buildWarehouseOverviewPdf(store, prev, cur),
      });
    }

    if (!send) {
      const f = files[0];
      if (!f) return NextResponse.json({ error: problems.join("; ") }, { status: 409 });
      return new NextResponse(Buffer.from(f.pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="warehouse-overview-${f.store}.pdf"` } });
    }

    if (problems.length > 0) {
      await notifyOwner(`⏸ <b>PDF «Склад — обзор» закупщику не отправлен по городам</b>\n${problems.join("\n")}\nДанным верить нельзя — после исправления отправьте вручную или дождитесь следующего понедельника.`);
    }
    const { data: buyers, error } = await supabaseAdmin.from("coach_users").select("telegram_chat_id, employee_name").eq("status", "approved").eq("is_buyer", true);
    if (error) throw error;
    if (!buyers || buyers.length === 0) {
      if (files.length > 0) await notifyOwner("⏸ <b>PDF «Склад — обзор» не отправлен</b>\nНет закупщика в боте-помощнике: он ещё не подключился по ссылке-приглашению.");
      return NextResponse.json({ sent: false, reason: "нет закупщика", problems }, { status: 404 });
    }
    for (const buyer of buyers) {
      for (const f of files) await sendCoachDocument(buyer.telegram_chat_id, f.name, f.pdf, f.caption);
    }
    return NextResponse.json({ sent: true, to: buyers.map((b) => b.employee_name), files: files.map((f) => f.name), problems });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
