// Тексты отчётов бота СММ: аналитика постов за период, расход на рекламу, список таргета.
import { CITIES, CITY_KEYS, type CityKey } from "@/lib/smm/config";
import { accountTotals, adInsightsByAd, adSpend, emptyAdStats, listPosts, listTargetPosts, type AdStats, type Post } from "@/lib/smm/meta";
import { daysIn, periodLabel, type Period } from "@/lib/smm/periods";
import { escapeHtml, packSections } from "@/lib/telegram";

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

const div = (a: number, b: number) => (b > 0 ? a / b : 0);

// Аналитика таргета: активные сейчас публикации города с цифрами за период (цена клика, клики, показы, лайки и т. д.).
export async function targetReport(city: CityKey, p: Period): Promise<string[]> {
  const posts = await listTargetPosts(city);
  const head = `🎯 <b>Сейчас в таргете · ${CITIES[city].title}</b>
${periodLabel(p)}
Активных публикаций: ${posts.length}`;
  if (posts.length === 0) return [`${head}
Ничего не включено.`];
  const ins = await adInsightsByAd(city, p);
  const rows = posts.map((post) => {
    const s = emptyAdStats();
    for (const id of post.adIds) {
      const x = ins.get(id);
      if (!x) continue;
      for (const k of Object.keys(s) as (keyof AdStats)[]) s[k] += x[k];
    }
    return { post, s };
  });
  rows.sort((a, b) => b.s.spend - a.s.spend);
  const total = emptyAdStats();
  for (const r of rows) for (const k of Object.keys(total) as (keyof AdStats)[]) total[k] += r.s[k];

  const statLines = (s: AdStats): string[] => {
    const l: string[] = [`💵 ${usd(s.spend)} · 👁 ${n(s.impressions)} · 🎯 охват ${n(s.reach)}`];
    l.push(`🖱 Клики ${n(s.clicks)} · цена клика ${usd(div(s.spend, s.clicks))} · CTR ${div(s.clicks * 100, s.impressions).toFixed(2)}%`);
    if (s.linkClicks > 0) l.push(`🔗 По ссылке ${n(s.linkClicks)} · цена ${usd(div(s.spend, s.linkClicks))}`);
    l.push(`❤️ ${n(s.reactions)} · 💬 ${n(s.comments)} · ↗️ ${n(s.shares)} · 🔖 ${n(s.saves)}${s.videoViews > 0 ? ` · ▶️ ${n(s.videoViews)}` : ""}`);
    if (s.conversations > 0) l.push(`✉️ Переписок ${n(s.conversations)} · цена ${usd(div(s.spend, s.conversations))}`);
    return l;
  };
  const sections = [`${head}\n\n<b>Итого по активным сейчас</b> (без выключенных, поэтому меньше общего расхода)\n${statLines(total).join("\n")}\nПоказ тысячи (CPM): ${usd(div(total.spend * 1000, total.impressions))}`];
  rows.forEach(({ post, s }, i) => {
    const title = `${i + 1}. ${post.objectType === "VIDEO" ? "🎬" : "🖼"} <b>${escapeHtml(post.campaign || post.adNames[0] || "Публикация")}</b>${post.permalink ? ` · <a href="${escapeHtml(post.permalink)}">ссылка</a>` : ""} · объявлений ${post.adIds.length}`;
    sections.push(`${title}\n${s.spend === 0 && s.impressions === 0 ? "За этот период показов не было." : statLines(s).join("\n")}`);
  });
  return packSections(sections);
}
