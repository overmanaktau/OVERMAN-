// Автозаполнение «Маркетинг → Внесение данных» за вчера (решение владельца 09.11.2026, «делай так каждый день»):
//  · Instagram по каждому городу = расход рекламного кабинета Meta за этот день (USD) × последний курс продажи USD сайта МиГ (mig.kz) за этот день;
//  · 2ГИС в Актау = 3 620 ₸ в день.
// Пишется только в строки, которые ещё не внесены (channels_entered = false): внесённое вручную не трогаем. Строку без записи создаём. Владельцу — итог или причина сбоя.
// Запускается ночью из /api/traffic/sync (03:00, повторы 06:00 и 09:00 — они ничего не делают, если уже внесено) и вручную: /api/marketing/auto-fill.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { graph } from "@/lib/smm/meta";
import { CITIES, type CityKey } from "@/lib/smm/config";
import { getErrorMessage } from "@/lib/errors";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { trim2Ru } from "@/lib/numFormat";

const STORE: Record<CityKey, string> = { aktau: "point_1", aktobe: "point_3" };
const TITLE: Record<CityKey, string> = { aktau: "Актау", aktobe: "Актобе" };
const TWO_GIS_AKTAU = 3620; // ₸ в день, только Актау
const MONTHS: Record<string, number> = { января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12 };

const ru = (ymd: string) => ymd.split("-").reverse().join(".");
const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

// Курс продажи USD «МиГ»: последний курс, действовавший в конце дня `date` (курс меняется несколько раз в сутки, в выходные может не меняться — берём последнюю запись не позже этого дня).
export async function migUsdSellRate(date: string): Promise<{ rate: number; at: string }> {
  const from = addDays(date, -10);
  const body = `page=1&from[day]=${Number(from.slice(8))}&from[month]=${Number(from.slice(5, 7))}&from[year]=${from.slice(0, 4)}&to[day]=${Number(date.slice(8))}&to[month]=${Number(date.slice(5, 7))}&to[year]=${date.slice(0, 4)}`;
  const res = await fetch("https://mig.kz/archive/search", {
    method: "POST",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OvermanPortal)", "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`МиГ ответил ${res.status}`);
  const html = await res.text();
  // строки таблицы: новые сверху; первая колонка «09 ноября 2026 10:27», вторая и третья — USD покупка и продажа
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const m = /^(\d{1,2}) (\S+) (\d{4}) (\d{2}):(\d{2})/.exec(cells[0] ?? "");
    if (!m || !MONTHS[m[2]]) continue;
    const day = `${m[3]}-${String(MONTHS[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (day > date) continue;
    const sell = Number(cells[2]);
    if (Number.isFinite(sell) && sell > 0) return { rate: sell, at: `${ru(day)} ${m[4]}:${m[5]}` };
  }
  throw new Error("в архиве МиГ нет курса USD за этот период");
}

async function metaSpendUsd(city: CityKey, date: string): Promise<number> {
  const r = await graph<{ data?: { spend?: string; account_currency?: string }[] }>(`/${CITIES[city].ad}/insights`, {
    fields: "spend,account_currency",
    time_range: JSON.stringify({ since: date, until: date }),
    time_increment: "1",
  });
  const row = r.data?.[0];
  if (!row) return 0; // в этот день рекламы не было
  if (row.account_currency && row.account_currency !== "USD") throw new Error(`валюта кабинета ${TITLE[city]} — ${row.account_currency}, а не USD`);
  return Number(row.spend ?? 0);
}

type Result = { store: string; city: string; action: string; instagram?: number; usd?: number; twoGis?: number };

export async function autoFillMarketing(date: string, dry = false): Promise<{ date: string; rate?: { rate: number; at: string }; results: Result[] }> {
  const results: Result[] = [];
  try {
    const rate = await migUsdSellRate(date);
    for (const city of Object.keys(CITIES) as CityKey[]) {
      const store = STORE[city];
      const { data: row, error } = await supabaseAdmin.from("traffic_entries").select("id, channels_entered, instagram, two_gis").eq("store", store).eq("entry_date", date).maybeSingle();
      if (error) throw error;
      if (row?.channels_entered) {
        results.push({ store, city: TITLE[city], action: "пропущено: строка уже внесена" });
        continue;
      }
      const usd = await metaSpendUsd(city, date);
      const instagram = Math.round(usd * rate.rate * 100) / 100;
      const twoGis = city === "aktau" ? TWO_GIS_AKTAU : undefined;
      if (instagram === 0 && twoGis === undefined) {
        results.push({ store, city: TITLE[city], action: "нечего вносить: рекламы в этот день не было" });
        continue;
      }
      if (!dry) {
        const patch = { instagram, ...(twoGis !== undefined ? { two_gis: twoGis } : {}), channels_entered: true };
        const { error: writeError } = row
          ? await supabaseAdmin.from("traffic_entries").update(patch).eq("id", row.id)
          : await supabaseAdmin.from("traffic_entries").insert({ store, entry_date: date, ...patch });
        if (writeError) throw writeError;
      }
      results.push({ store, city: TITLE[city], action: dry ? "внёс бы" : "внесено", instagram, usd, twoGis });
    }
    return { date, rate, results };
  } catch (e) {
    if (!dry) await notifyOwner(`⚠️ <b>Расход за ${ru(date)} в «Внесении данных» не внесён</b>\nПричина: ${getErrorMessage(e)}\nБот попробует ещё раз утром, или скажите мне — внесу вручную.`);
    throw e;
  }
}

// Сообщение владельцу о том, что внесено (если что-то внесли).
export async function notifyFilled(date: string, rate: { rate: number; at: string }, results: Result[]): Promise<void> {
  const done = results.filter((r) => r.action === "внесено");
  if (done.length === 0) return;
  const lines = done.map((r) => `${r.city}: Instagram ${trim2Ru(r.instagram ?? 0)} ₸ (${trim2Ru(r.usd ?? 0)} $ × ${rate.rate})${r.twoGis !== undefined ? `, 2ГИС ${trim2Ru(r.twoGis)} ₸` : ""}`);
  await notifyOwner(`✅ <b>Расход за ${ru(date)} внесён в «Внесение данных»</b>\n${lines.join("\n")}\nКурс продажи МиГ: ${rate.rate} ₸ на ${rate.at}.`);
}
