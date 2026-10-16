// Тексты отчётов бота СММ: аналитика постов за период, расход на рекламу, список таргета.
import { CITIES, CITY_KEYS, type CityKey } from "@/lib/smm/config";
import { accountTotals, adSpend, listPosts, type Post, type TargetPost } from "@/lib/smm/meta";
import { daysIn, periodLabel, type Period } from "@/lib/smm/periods";
import { escapeHtml } from "@/lib/telegram";

const n = (v: number) => Math.round(v).toLocaleString("ru-RU");
const usd = (v: number) => `$${v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const alm = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 5 * 3600000).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)}`;
};

export type PostsData = { posts: Post[]; truncated: boolean };

export async function postsReport(city: CityKey, p: Period): Promise<{ text: string; data: PostsData }> {
  const data = await listPosts(city, p);
  const acc = await accountTotals(city, p).catch(() => null);
  const { posts } = data;
  const sum = (f: (x: Post) => number) => posts.reduce((a, x) => a + f(x), 0);
  const byType = new Map<string, number>();
  for (const x of posts) byType.set(x.type, (byType.get(x.type) ?? 0) + 1);
  const types = [...byType.entries()].map(([t, c]) => `${t} ${c}`).join(", ");
  const head = `📊 <b>Аналитика постов · ${CITIES[city].title}</b>\n${periodLabel(p)}${daysIn(p) > 1 ? ` (${daysIn(p)} дн.)` : ""}`;
  const lines: string[] = [head, ""];
  if (posts.length === 0) {
    lines.push("Публикаций за этот период нет.");
  } else {
    lines.push(`Публикаций: <b>${posts.length}</b> (${types})`);
    lines.push(`👁 Просмотры: <b>${n(sum((x) => x.views))}</b> · 🎯 Охват (сумма по постам): ${n(sum((x) => x.reach))}`);
    lines.push(`❤️ Лайки: <b>${n(sum((x) => x.likes))}</b> · 💬 Комментарии: ${n(sum((x) => x.comments))}`);
    lines.push(`🔖 Сохранения: ${n(sum((x) => x.saved))} · ↗️ Репосты: ${n(sum((x) => x.shares))}`);
    lines.push(`В среднем на пост: 👁 ${n(sum((x) => x.views) / posts.length)} · ❤️ ${n(sum((x) => x.likes) / posts.length)} · 💬 ${n(sum((x) => x.comments) / posts.length)}`);
  }
  if (acc) {
    lines.push("", `<b>Аккаунт за период</b> (посты, истории и рилсы вместе)`);
    lines.push(`👁 Просмотры: ${n(acc.views)}${acc.reach !== null ? ` · 🎯 Охват: ${n(acc.reach)}` : ""}`);
    lines.push(`🙋 Вовлечённых аккаунтов: ${n(acc.engaged)} · ❤️ ${n(acc.likes)} · 💬 ${n(acc.comments)} · 🔖 ${n(acc.saves)} · ↗️ ${n(acc.shares)}`);
    lines.push(`👥 Подписчиков сейчас: ${n(acc.followers)}`);
  }
  if (posts.length > 0) {
    const top = [...posts].sort((a, b) => b.views - a.views || b.likes - a.likes).slice(0, 5);
    lines.push("", "<b>🏆 Топ-5 по просмотрам</b>");
    top.forEach((x, i) => lines.push(`${i + 1}. ${alm(x.postedAt)} ${x.type} · 👁 ${n(x.views)} · ❤️ ${n(x.likes)} · 💬 ${n(x.comments)} · <a href="${escapeHtml(x.permalink)}">ссылка</a>`));
  }
  if (data.truncated) lines.push("", "⚠️ Публикаций больше 200 — показаны первые 200 по дате, выберите период покороче.");
  return { text: lines.join("\n"), data };
}

export function allPostsText(city: CityKey, p: Period, posts: Post[]): string {
  const head = `📃 <b>Все публикации · ${CITIES[city].title}</b>\n${periodLabel(p)} · ${posts.length} шт.`;
  const sorted = [...posts].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  return `${head}\n\n${sorted.map((x) => `${alm(x.postedAt)} ${x.type} · 👁 ${n(x.views)} · 🎯 ${n(x.reach)} · ❤️ ${n(x.likes)} · 💬 ${n(x.comments)} · 🔖 ${n(x.saved)} · ↗️ ${n(x.shares)} · <a href="${escapeHtml(x.permalink)}">ссылка</a>`).join("\n")}`;
}

export async function spendText(p: Period): Promise<string> {
  const lines = [`💵 <b>Расход на рекламу</b>\n${periodLabel(p)}`, ""];
  let total = 0;
  for (const city of CITY_KEYS) {
    try {
      const s = await adSpend(city, p);
      total += s.spend;
      lines.push(`<b>${CITIES[city].title}</b>: ${usd(s.spend)} · показов ${n(s.impressions)} · кликов ${n(s.clicks)}`);
    } catch (e) {
      lines.push(`<b>${CITIES[city].title}</b>: не удалось получить (${escapeHtml(e instanceof Error ? e.message : String(e))})`);
    }
  }
  lines.push("", `Итого: <b>${usd(total)}</b>`);
  return lines.join("\n");
}

export function targetText(city: CityKey, posts: TargetPost[]): string {
  const head = `🎯 <b>Сейчас в таргете · ${CITIES[city].title}</b>\nАктивных публикаций: ${posts.length}`;
  if (posts.length === 0) return `${head}\nНичего не включено.`;
  return `${head}\n\n${posts
    .map((p, i) => `${i + 1}. ${p.objectType === "VIDEO" ? "🎬" : "🖼"} ${escapeHtml(p.campaign || p.adNames[0] || "Публикация")} · объявлений: ${p.adIds.length}${p.permalink ? ` · <a href="${escapeHtml(p.permalink)}">ссылка</a>` : ""}`)
    .join("\n")}`;
}
