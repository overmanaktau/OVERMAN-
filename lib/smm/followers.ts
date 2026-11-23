// Сводка «новые подписчики Instagram за неделю» для владельца (бот СММ, только администратор): прошлая неделя против позапрошлой по каждому городу.
// Данные — follower_count из Meta по суткам (сутки по тихоокеанскому времени, значение приходит с задержкой 1–2 дня). Недостающие последние дни
// недели оцениваем средним за последние 7 известных дней и показываем это отдельно, чтобы не выдавать оценку за факт.
import { CITIES, CITY_KEYS, type CityKey } from "@/lib/smm/config";
import { graph } from "@/lib/smm/meta";
import { lastWeek } from "@/lib/smm/targetReport";
import { escapeHtml } from "@/lib/telegram";

const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const unix = (ymd: string) => String(Math.floor(new Date(`${ymd}T00:00:00Z`).getTime() / 1000));
const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const num = (n: number) => nf.format(Math.round(n)).replace(/[  ]/g, " ");
const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;

type Week = { from: string; to: string; sum: number; known: number; days: number; estimate: number };

// сутки → число новых подписчиков (по дню, который закрывает метка end_time: она в 08:00 UTC следующего дня)
async function dailyFollowers(city: CityKey, from: string, to: string): Promise<Map<string, number>> {
  const r = await graph<any>(`/${CITIES[city].ig}/insights`, { metric: "follower_count", period: "day", since: unix(addDays(from, -1)), until: unix(addDays(to, 4)) });
  const out = new Map<string, number>();
  for (const v of r.data?.[0]?.values ?? []) out.set(addDays(String(v.end_time).slice(0, 10), -1), Number(v.value) || 0);
  return out;
}

function weekStats(daily: Map<string, number>, from: string, to: string, lastKnown: string | null, avg7: number): Week {
  let sum = 0;
  let known = 0;
  const days = 7;
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    if (lastKnown !== null && d <= lastKnown && daily.has(d)) {
      sum += daily.get(d) ?? 0;
      known++;
    }
  }
  return { from, to, sum, known, days, estimate: sum + avg7 * (days - known) };
}

export async function followersSummary(): Promise<string> {
  const cur = lastWeek();
  const prev = { from: addDays(cur.from, -7), to: addDays(cur.to, -7) };
  const lines: string[] = ["👥 <b>Новые подписчики Instagram</b>"];
  for (const city of CITY_KEYS) {
    const daily = await dailyFollowers(city, prev.from, cur.to);
    // последний день с настоящим значением: хвост из нулей — это ещё не посчитанные Meta сутки
    const known = [...daily.entries()].filter(([, v]) => v > 0).map(([d]) => d).sort();
    const lastKnown = known.length > 0 ? known[known.length - 1] : null;
    const last7 = known.slice(-7);
    const avg7 = last7.length > 0 ? last7.reduce((a, d) => a + (daily.get(d) ?? 0), 0) / last7.length : 0;
    const w2 = weekStats(daily, cur.from, cur.to, lastKnown, avg7);
    const w1 = weekStats(daily, prev.from, prev.to, lastKnown, avg7);
    let total: number | null = null;
    try {
      const acc = await graph<any>(`/${CITIES[city].ig}`, { fields: "followers_count" });
      total = Number(acc.followers_count);
    } catch {
      total = null;
    }
    const growth = w1.estimate > 0 ? ((w2.estimate - w1.estimate) / w1.estimate) * 100 : null;
    const part = (w: Week) => (w.known === w.days ? `<b>${num(w.sum)}</b>` : `<b>${num(w.sum)}</b> за ${w.known} из ${w.days} дн., с оценкой недостающих ≈ <b>${num(w.estimate)}</b>`);
    lines.push(
      "",
      `<b>${escapeHtml(CITIES[city].title)}</b>${total !== null && Number.isFinite(total) ? ` · всего ${num(total)}` : ""}`,
      `${dm(w2.from)}–${dm(w2.to)}: ${part(w2)}`,
      `${dm(w1.from)}–${dm(w1.to)}: ${part(w1)}`,
      ...(growth !== null ? [`Изменение: ${growth >= 0 ? "+" : "−"}${Math.abs(Math.round(growth))}%${w2.known < w2.days ? " (по оценке)" : ""}`] : [])
    );
  }
  lines.push("", "Meta отдаёт цифры с задержкой 1–2 дня; сутки у неё по тихоокеанскому времени (граница дня около 13:00 по Алматы). Оценка — среднее за последние 7 известных дней.");
  return lines.join("\n");
}
