// «Мои задачи» в боте СММ — только для администратора (владельца): ежедневные фиксированные задачи по обоим городам и их выполнение (решение владельца 15.11.2026).
// Проверяются по данным: сторис (минимум 10 в день), посты Instagram (минимум 3), запуск таргета (минимум 1 новый за день).
// Отмечаются вручную кнопкой: 3 поста в TikTok, проверка Telegram-отчётов, проверка расходов по каналам (отметки лежат в smm_task_checks).
// Записи за день есть только когда подтверждены: «не нажал» значит «не сделано».
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { trim2Ru } from "@/lib/numFormat";
import { addDays, todayInAlmaty } from "@/lib/coach/metrics";
import { CITIES, CITY_KEYS, type CityKey } from "@/lib/smm/config";
import { graph } from "@/lib/smm/meta";
import { periodUtc, type Period } from "@/lib/smm/periods";
import type { ReplyMarkup, Transport } from "@/lib/smm/telegram";

export const NORM = { stories: 10, posts: 3, targets: 1 };
type ManualKey = "tiktok" | "reports" | "spend";
const MANUAL: { key: ManualKey; label: string; button: string }[] = [
  { key: "tiktok", label: "TikTok: 3 поста", button: "TikTok" },
  { key: "reports", label: "Telegram-отчёты проверены", button: "Отчёты" },
  { key: "spend", label: "Расходы по каналам проверены", button: "Расходы" },
];
const TOTAL = 3 + MANUAL.length; // задач в день на город
const CODE: Record<CityKey, string> = { aktau: "a", aktobe: "b" };
const CITY_OF: Record<string, CityKey> = { a: "aktau", b: "aktobe" };
const STORE: Record<CityKey, string> = { aktau: "point_1", aktobe: "point_3" }; // коды точек в traffic_entries
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const plain = (ymd: string) => ymd.replace(/-/g, "");
const fromPlain = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
const wd = (ymd: string) => WD[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
const almatyDay = (iso: string) => new Date(Date.parse(iso) + 5 * 3600000).toISOString().slice(0, 10);
const rub = (n: number) => `${trim2Ru(n)} ₸`;

type CityData = {
  stories: Map<string, number>;
  posts: Map<string, number> | null; // null — Instagram не ответил
  targets: Map<string, number>;
  manual: Set<string>; // «дата|задача»
};

function bump(m: Map<string, number>, key: string) {
  m.set(key, (m.get(key) ?? 0) + 1);
}

// Публикации аккаунта по дням: только даты (без цифр по каждой, как в аналитике), поэтому быстро. Reels, видео, карусели и посты считаются вместе.
async function postsByDay(city: CityKey, p: Period): Promise<Map<string, number> | null> {
  try {
    const { fromIso, toIso } = periodUtc(p);
    const out = new Map<string, number>();
    let page = await graph<{ data?: { timestamp: string }[]; paging?: { next?: string } }>(`/${CITIES[city].ig}/media`, { fields: "timestamp", limit: "100" });
    for (let i = 0; i < 6; i++) {
      for (const m of page.data ?? []) {
        const iso = new Date(String(m.timestamp).replace("+0000", "Z")).toISOString();
        if (iso < fromIso) return out;
        if (iso < toIso) bump(out, almatyDay(iso));
      }
      if (!page.paging?.next) break;
      page = await graph(page.paging.next);
    }
    return out;
  } catch {
    return null;
  }
}

async function loadCity(city: CityKey, p: Period): Promise<CityData> {
  const { fromIso, toIso } = periodUtc(p);
  const [stories, targets, checks, posts] = await Promise.all([
    supabaseAdmin.from("smm_story_log").select("posted_at").eq("city", city).gte("posted_at", fromIso).lt("posted_at", toIso).limit(5000),
    supabaseAdmin.from("smm_target_posts").select("started_at").eq("city", city).gte("started_at", fromIso).lt("started_at", toIso).limit(5000),
    supabaseAdmin.from("smm_task_checks").select("task_date, task").eq("city", city).gte("task_date", p.from).lte("task_date", p.to),
    postsByDay(city, p),
  ]);
  if (stories.error) throw stories.error;
  if (targets.error) throw targets.error;
  if (checks.error) throw checks.error;
  const s = new Map<string, number>();
  for (const r of (stories.data ?? []) as { posted_at: string }[]) bump(s, almatyDay(r.posted_at));
  const tg = new Map<string, number>();
  for (const r of (targets.data ?? []) as { started_at: string }[]) bump(tg, almatyDay(r.started_at));
  const manual = new Set(((checks.data ?? []) as { task_date: string; task: string }[]).map((r) => `${r.task_date}|${r.task}`));
  return { stories: s, posts, targets: tg, manual };
}

// Сколько задач за день выполнено из шести
function doneCount(d: CityData, date: string): number {
  let n = 0;
  if ((d.stories.get(date) ?? 0) >= NORM.stories) n++;
  if ((d.posts?.get(date) ?? 0) >= NORM.posts) n++;
  if ((d.targets.get(date) ?? 0) >= NORM.targets) n++;
  for (const m of MANUAL) if (d.manual.has(`${date}|${m.key}`)) n++;
  return n;
}

// Расходы по каналам города за день (то, что внесено в «Внесение данных»)
async function spendLine(city: CityKey, date: string): Promise<string> {
  const { data } = await supabaseAdmin.from("traffic_entries").select("instagram, tiktok, instagram_public, flyer, two_gis").eq("store", STORE[city]).eq("entry_date", date).maybeSingle();
  if (!data) return `за ${dm(date)} расходов в «Внесении данных» нет`;
  const r = data as Record<string, number | string | null>;
  const n = (k: string) => Number(r[k] ?? 0);
  return `за ${dm(date)}: Instagram ${rub(n("instagram"))} · TikTok ${rub(n("tiktok"))} · паблик/блогер ${rub(n("instagram_public"))} · флаер ${rub(n("flyer"))} · 2ГИС ${rub(n("two_gis"))}`;
}

const auto = (ok: boolean, date: string, today: string) => (ok ? "✅" : date < today ? "❌" : "🔸");
const hand = (ok: boolean, date: string, today: string) => (ok ? "✅" : date < today ? "❌" : "⬜");

async function dayView(date: string): Promise<{ text: string; markup: ReplyMarkup }> {
  const today = todayInAlmaty();
  const data = await Promise.all(CITY_KEYS.map((c) => loadCity(c, { from: date, to: date })));
  const spend = await Promise.all(CITY_KEYS.map((c) => spendLine(c, addDays(date, -1))));
  const lines: string[] = [`📋 <b>Мои задачи · ${date === today ? "сегодня" : date === addDays(today, -1) ? "вчера" : wd(date)} ${dm(date)}</b>`];
  let done = 0;
  CITY_KEYS.forEach((city, i) => {
    const d = data[i];
    const st = d.stories.get(date) ?? 0;
    const tg = d.targets.get(date) ?? 0;
    const ps = d.posts ? (d.posts.get(date) ?? 0) : null;
    done += doneCount(d, date);
    lines.push("", `<b>${CITIES[city].title}</b>`);
    lines.push(`${auto(st >= NORM.stories, date, today)} Сторис: ${st} из ${NORM.stories}`);
    lines.push(ps === null ? "❔ Посты: Instagram не ответил" : `${auto(ps >= NORM.posts, date, today)} Посты: ${ps} из ${NORM.posts}`);
    lines.push(`${auto(tg >= NORM.targets, date, today)} Таргет: запущено ${tg} (минимум ${NORM.targets})`);
    for (const m of MANUAL) lines.push(`${hand(d.manual.has(`${date}|${m.key}`), date, today)} ${m.label}`);
    lines.push(`<i>расходы ${spend[i]}</i>`);
  });
  lines.push("", `Выполнено: <b>${done} из ${TOTAL * CITY_KEYS.length}</b>`);
  if (date === today) lines.push("<i>🔸 — ещё можно успеть, ⬜ — ждёт вашей отметки</i>");

  const rows: { text: string; callback_data: string }[][] = [];
  for (const m of MANUAL) {
    rows.push(CITY_KEYS.map((c, i) => ({ text: `${data[i].manual.has(`${date}|${m.key}`) ? "✅" : "⬜"} ${m.button} · ${CITIES[c].title}`, callback_data: `mt|t|${plain(date)}|${CODE[c]}|${m.key}` })));
  }
  const nav: { text: string; callback_data: string }[] = [{ text: `◀ ${dm(addDays(date, -1))}`, callback_data: `mt|d|${plain(addDays(date, -1))}` }];
  if (date < today) nav.push({ text: `${dm(addDays(date, 1))} ▶`, callback_data: `mt|d|${plain(addDays(date, 1))}` });
  rows.push(nav);
  rows.push([
    { text: "📅 Неделя", callback_data: "mt|w" },
    { text: "🔄 Обновить", callback_data: `mt|d|${plain(date)}` },
  ]);
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

// Итог за последние шесть полных дней (без сегодняшнего): сколько раз выполнена каждая задача и сколько задач по дням
async function weekView(): Promise<{ text: string; markup: ReplyMarkup }> {
  const today = todayInAlmaty();
  const from = addDays(today, -6);
  const to = addDays(today, -1);
  const days = Array.from({ length: 6 }, (_, i) => addDays(from, i));
  const data = await Promise.all(CITY_KEYS.map((c) => loadCity(c, { from, to })));
  const lines: string[] = [`📅 <b>Неделя · ${dm(from)}–${dm(to)}</b>`, "<i>полные дни, без сегодняшнего</i>"];
  CITY_KEYS.forEach((city, i) => {
    const d = data[i];
    const count = (f: (date: string) => boolean) => days.filter(f).length;
    const stories = count((x) => (d.stories.get(x) ?? 0) >= NORM.stories);
    const posts = count((x) => (d.posts?.get(x) ?? 0) >= NORM.posts);
    const targets = count((x) => (d.targets.get(x) ?? 0) >= NORM.targets);
    const total = days.reduce((a, x) => a + doneCount(d, x), 0);
    lines.push("", `<b>${CITIES[city].title} · ${Math.round((total / (TOTAL * days.length)) * 100)}%</b> (${total} из ${TOTAL * days.length})`);
    lines.push(`Сторис ${stories}/6 · Посты ${d.posts ? `${posts}/6` : "нет данных"} · Таргет ${targets}/6`);
    lines.push(MANUAL.map((m) => `${m.button} ${count((x) => d.manual.has(`${x}|${m.key}`))}/6`).join(" · "));
  });
  lines.push("", "<b>По дням</b> (сколько задач из шести):");
  for (const x of days) lines.push(`${wd(x)} ${dm(x)} · ${CITY_KEYS.map((c, i) => `${CITIES[c].title} ${doneCount(data[i], x)}`).join(" · ")}`);
  return { text: lines.join("\n"), markup: { inline_keyboard: [[{ text: "📋 Сегодня", callback_data: `mt|d|${plain(today)}` }]] } };
}

async function put(t: Transport, chat: number, messageId: number | undefined, v: { text: string; markup: ReplyMarkup }) {
  if (messageId) await t.edit(chat, messageId, v.text, v.markup);
  else await t.send(chat, v.text, v.markup);
}

export async function showMyTasks(t: Transport, chat: number, messageId?: number, date?: string): Promise<void> {
  await put(t, chat, messageId, await dayView(date ?? todayInAlmaty()));
}

// Нажатия кнопок «mt|…»: d — показать день, w — неделя, t — поставить или снять отметку
export async function handleMyTasksCallback(t: Transport, chat: number, messageId: number | undefined, args: string[]): Promise<void> {
  const today = todayInAlmaty();
  if (args[0] === "w") {
    await put(t, chat, messageId, await weekView());
    return;
  }
  const date = /^\d{8}$/.test(args[1] ?? "") ? fromPlain(args[1]) : today;
  if (date > today) return;
  if (args[0] === "t") {
    const city = CITY_OF[args[2]];
    const task = MANUAL.find((m) => m.key === args[3])?.key;
    if (!city || !task) return;
    const { data, error } = await supabaseAdmin.from("smm_task_checks").select("task").eq("task_date", date).eq("city", city).eq("task", task).maybeSingle();
    if (error) throw error;
    const { error: wErr } = data
      ? await supabaseAdmin.from("smm_task_checks").delete().eq("task_date", date).eq("city", city).eq("task", task)
      : await supabaseAdmin.from("smm_task_checks").insert({ task_date: date, city, task });
    if (wErr) throw wErr;
  }
  await put(t, chat, messageId, await dayView(date));
}
