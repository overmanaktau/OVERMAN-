// Недельный отчёт по таргету для владельца (бот СММ, только роль «администратор»): публикации, которые шли в таргете за выбранный период,
// по 4 в ряд на листе A4 — обложка, даты «от — до» по реальному расходу, статус «идёт / завершено», цифры из рекламного кабинета Meta.
// Актау — три отчёта по аудитории групп объявлений (Актау / Мангистау / Похожая аудитория), заголовок — название кампании так, как оно написано в Meta.
// Актобе — один отчёт: каждое видео продвигается кнопкой «Продвигать» и создаёт свою кампанию, поэтому город учитываем целиком.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { jsPDF } from "jspdf";
import { CITIES, type CityKey } from "@/lib/smm/config";
import { graph, postCover } from "@/lib/smm/meta";
import { sendSmmDocument } from "@/lib/smm/telegram";
import { approvedUsers, markSent, wasSent } from "@/lib/smm/users";
import { trim2Ru } from "@/lib/numFormat";
import { escapeHtml } from "@/lib/telegram";

const AKTAU_CITY_KEY = "1289448"; // город Актау в таргетинге Meta
const LOOKBACK_DAYS = 60; // насколько назад ищем настоящий день запуска публикации
const CLICK_PRICE_LIMIT = 0.08; // $: цена клика от этого значения красится в светло-красный, ниже — зелёная (решение владельца, 0,08 $)

type Stats = { spend: number; impressions: number; reach: number; clicks: number; likes: number; comments: number; saves: number; views: number };
type Pub = { seg: string; key: string; mediaId: string | null; thumb: string | null; ads: Set<string>; stats: Stats; first: string; last: string };
type Cover = { data: string; fmt: "JPEG" | "PNG" } | null;
export type TargetReport = { title: string; fileName: string; bytes: Uint8Array; publications: number; spend: number };

const num = (n: number) => Math.round(n).toLocaleString("ru-RU");
const usd = (n: number) => `${trim2Ru(Math.round(n * 100) / 100)} $`;
const ddmm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const ruDate = (s: string) => s.split("-").reverse().join(".");
const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

// Сегодня по Алматы (UTC+5)
export const almatyToday = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);

// Прошлая неделя (понедельник — воскресенье) относительно сегодняшнего дня по Алматы
export function lastWeek(today = almatyToday()): { from: string; to: string } {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 — воскресенье
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  return { from: addDays(monday, -7), to: addDays(monday, -1) };
}

// Аудитория группы объявлений: «Похожая аудитория» (look-alike), «Мангистау» (вся область без города Актау), «Актау» (остальное: город, радиус, продвижение кнопкой).
function segmentOf(city: CityKey, ad: any): string {
  if (city !== "aktau") return "all";
  const t = ad.adset?.targeting ?? {};
  const aud = (t.custom_audiences ?? []).map((x: any) => String(x.name ?? "")).join(" ");
  const names = `${ad.campaign?.name ?? ""} ${ad.adset?.name ?? ""} ${aud}`.toLowerCase();
  if (/похож|lookalike/.test(names)) return "similar";
  const geo = t.geo_locations ?? {};
  const cities: any[] = geo.cities ?? [];
  const regions: any[] = geo.regions ?? [];
  const hasAktau = cities.some((c) => String(c.key) === AKTAU_CITY_KEY);
  const inMang = regions.some((r) => /mangystau/i.test(String(r.name ?? ""))) || cities.some((c) => /mangystau/i.test(String(c.region ?? "")));
  if (!hasAktau && (inMang || /манг/.test(names))) return "mang";
  return "aktau";
}

const FALLBACK_TITLE: Record<string, string> = { all: "Актобе", aktau: "Актау", mang: "Мангистау", similar: "Похожая аудитория" };
const isPromote = (name: string) => /^(публикация в instagram|instagram post)/i.test(name.trim()); // кампании, созданные кнопкой «Продвигать» — по одной на видео

export async function loadFonts() {
  const get = async (name: string) => {
    try {
      return (await readFile(path.join(process.cwd(), "public", "fonts", "pdf", name))).toString("base64");
    } catch {
      const res = await fetch(`https://www.overman.kz/fonts/pdf/${name}`);
      if (!res.ok) throw new Error(`Шрифт ${name} недоступен.`);
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    }
  };
  const [regular, bold, serif] = await Promise.all([get("NotoSans-Regular.ttf"), get("NotoSans-Bold.ttf"), get("NotoSerif-Bold.ttf")]);
  return { regular, bold, serif };
}

async function loadCover(p: Pub): Promise<Cover> {
  try {
    const url = await postCover({ mediaId: p.mediaId, thumb: p.thumb });
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const ct = res.headers.get("content-type") ?? "";
    const fmt = ct.includes("png") ? "PNG" : ct.includes("jpeg") || ct.includes("jpg") ? "JPEG" : null;
    if (!fmt) return null;
    return { data: `data:${ct};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`, fmt };
  } catch {
    return null;
  }
}

type Fonts = Awaited<ReturnType<typeof loadFonts>>;

function renderPdf(list: Pub[], title: string, from: string, to: string, covers: Map<string, Cover>, fonts: Fonts, yesterday: string): Uint8Array {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  pdf.addFileToVFS("NotoSans-Regular.ttf", fonts.regular);
  pdf.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  pdf.addFileToVFS("NotoSans-Bold.ttf", fonts.bold);
  pdf.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  pdf.addFileToVFS("NotoSerif-Bold.ttf", fonts.serif);
  pdf.addFont("NotoSerif-Bold.ttf", "NotoSerif", "bold");
  const W = 210, H = 297, M = 8, COLS = 4, GAP = 3;
  const cardW = (W - 2 * M - GAP * (COLS - 1)) / COLS;
  const coverH = 50; // обложка заполняет рамку, лишнее по краям обрезается
  const lineH = 3.6;
  const metricRows: [string, (s: Stats) => string][] = [
    ["Потрачено", (s) => usd(s.spend)],
    ["Показы", (s) => num(s.impressions)],
    ["Охват", (s) => num(s.reach)],
    ["Просмотры", (s) => num(s.views)],
    ["Клики", (s) => num(s.clicks)],
    ["Цена клика", (s) => (s.clicks > 0 ? usd(s.spend / s.clicks) : "—")],
    ["Лайки", (s) => num(s.likes)],
    ["Комментарии", (s) => num(s.comments)],
    ["Сохранения", (s) => num(s.saves)],
  ];
  const cardH = 7.5 + coverH + 2.5 + 4.2 + Math.ceil(metricRows.length / 2) * lineH + 2; // цифры по две в строке
  const total = list.reduce((x, p) => x + p.stats.spend, 0);

  const header = (first: boolean) => {
    pdf.setFillColor(28, 26, 23);
    pdf.rect(0, 0, W, first ? 19 : 12, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("NotoSerif", "bold");
    let size = first ? 15 : 10;
    const text = `Таргет · ${title}`;
    pdf.setFontSize(size);
    while (size > 8 && pdf.getTextWidth(text) > W - 2 * M - 52) {
      size -= 0.5;
      pdf.setFontSize(size);
    }
    pdf.text(text, M, first ? 9 : 8);
    pdf.setFont("NotoSans", "normal");
    if (first) {
      pdf.setFontSize(8.5);
      pdf.text(`Публикации, которые шли в таргете: ${ruDate(from)} — ${ruDate(to)} · публикаций ${list.length} · потрачено ${usd(total)}`, M, 15);
    }
    pdf.setFontSize(7);
    pdf.text("OVERMAN · ПОРТАЛ БИЗНЕСА", W - M, first ? 9 : 8, { align: "right" });
  };

  header(true);
  const rowsPerPage = (first: boolean) => Math.floor((H - 9 - (first ? 23 : 16) + GAP) / (cardH + GAP)) || 1;
  let y = 23;
  let rowOnPage = 0;
  let limit = rowsPerPage(true);
  list.forEach((p, idx) => {
    const col = idx % COLS;
    if (idx > 0 && col === 0) {
      rowOnPage++;
      y += cardH + GAP;
      if (rowOnPage >= limit) {
        pdf.addPage();
        header(false);
        y = 16;
        rowOnPage = 0;
        limit = rowsPerPage(false);
      }
    }
    const x = M + col * (cardW + GAP);
    pdf.setFillColor(246, 243, 238);
    pdf.setDrawColor(228, 223, 214);
    pdf.setLineWidth(0.25);
    pdf.roundedRect(x, y, cardW, cardH, 1.8, 1.8, "FD");
    // даты «от — до» по реальному расходу
    const running = p.last >= yesterday; // расход вчера или сегодня — таргет реально идёт
    pdf.setFont("NotoSans", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(28, 26, 23);
    const dates = running ? `${ddmm(p.first)} — сейчас` : p.first === p.last ? ddmm(p.first) : `${ddmm(p.first)} — ${ddmm(p.last)}`;
    pdf.text(dates, x + cardW / 2, y + 3.6, { align: "center" });
    if (p.first < from || p.last > to) {
      pdf.setFont("NotoSans", "normal");
      pdf.setFontSize(6);
      pdf.setTextColor(140, 133, 119);
      pdf.text(`цифры за ${ddmm(from)} — ${ddmm(to)}`, x + cardW / 2, y + 6.3, { align: "center" });
    }
    // обложка целиком, по центру
    const bx = x + 1.5, by = y + 7.5, bw = cardW - 3, bh = coverH;
    pdf.setFillColor(232, 227, 217);
    pdf.rect(bx, by, bw, bh, "F");
    const cov = covers.get(p.key);
    if (cov) {
      const props = pdf.getImageProperties(cov.data);
      const k = Math.max(bw / props.width, bh / props.height);
      const iw = props.width * k, ih = props.height * k;
      pdf.saveGraphicsState();
      pdf.rect(bx, by, bw, bh, null);
      pdf.clip();
      pdf.discardPath();
      pdf.addImage(cov.data, cov.fmt, bx + (bw - iw) / 2, by + (bh - ih) / 2, iw, ih);
      pdf.restoreGraphicsState();
    } else {
      pdf.setFont("NotoSans", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(140, 133, 119);
      pdf.text("нет обложки", bx + bw / 2, by + bh / 2, { align: "center" });
    }
    // статус и цифры
    let ty = by + bh + 3.6;
    pdf.setFont("NotoSans", "bold");
    pdf.setFontSize(6.6);
    pdf.setTextColor(running ? 38 : 120, running ? 120 : 110, running ? 78 : 95);
    pdf.text(running ? "ИДЁТ СЕЙЧАС" : "ЗАВЕРШЕНО", x + 2.2, ty);
    pdf.setTextColor(140, 133, 119);
    pdf.setFont("NotoSans", "normal");
    pdf.text(`${p.ads.size} объявл.`, x + cardW - 2.2, ty, { align: "right" });
    ty += 3.9;
    const half = (cardW - 4) / 2;
    for (let i = 0; i < metricRows.length; i += 2) {
      for (let j = 0; j < 2 && i + j < metricRows.length; j++) {
        const [label, fn] = metricRows[i + j];
        const cx = x + 2 + j * half;
        // «Цена клика» выделена плашкой: до 0,08 $ зелёная, от 0,08 $ светло-красная
        const price = label === "Цена клика" && p.stats.clicks > 0;
        const tooHigh = price && Math.round((p.stats.spend / p.stats.clicks) * 100) / 100 >= CLICK_PRICE_LIMIT; // сравниваем с тем, что напечатано на листе (до цента)
        const ink = tooHigh ? [176, 70, 48] : [38, 120, 78];
        if (price) {
          const bg = tooHigh ? [246, 218, 210] : [214, 236, 221];
          pdf.setFillColor(bg[0], bg[1], bg[2]);
          pdf.rect(cx - 0.7, ty - 2.5, half, lineH, "F");
        }
        pdf.setFont("NotoSans", price ? "bold" : "normal");
        pdf.setFontSize(5.8);
        if (price) pdf.setTextColor(ink[0], ink[1], ink[2]);
        else pdf.setTextColor(91, 85, 72);
        pdf.text(label, cx, ty);
        pdf.setFont("NotoSans", "bold");
        if (price) pdf.setTextColor(ink[0], ink[1], ink[2]);
        else pdf.setTextColor(28, 26, 23);
        pdf.text(fn(p.stats), cx + half - 1.6, ty, { align: "right" });
      }
      ty += lineH;
    }
  });
  const pages = pdf.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    pdf.setFont("NotoSans", "normal");
    pdf.setFontSize(7);
    pdf.setTextColor(140, 133, 119);
    pdf.text("Даты — по реальному расходу. Цифры — за выбранный период (Meta); если объявлений несколько, они сложены.", M, H - 5);
    pdf.text(`Страница ${i} из ${pages}`, W - M, H - 5, { align: "right" });
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);

// Отчёты по городу за период. Пустые группы (в Актау бывает, что в какую-то аудиторию в эту неделю ничего не лили) пропускаются.
export async function buildTargetReports(city: CityKey, from: string, to: string): Promise<TargetReport[]> {
  const acc = CITIES[city].ad;
  const today = almatyToday();
  const yesterday = addDays(today, -1);
  // 1) расход и цифры по объявлениям по дням
  const rows: any[] = [];
  let page = await graph<any>(`/${acc}/insights`, {
    level: "ad", time_increment: "1", limit: "500",
    time_range: JSON.stringify({ since: addDays(from, -LOOKBACK_DAYS), until: today }),
    fields: "ad_id,date_start,spend,impressions,reach,clicks,actions",
  });
  for (let i = 0; i < 100; i++) {
    rows.push(...(page.data ?? []));
    if (!page.paging?.next) break;
    page = await graph<any>(page.paging.next);
  }
  const want = new Set(rows.filter((r) => Number(r.spend) > 0 && r.date_start >= from && r.date_start <= to).map((r) => String(r.ad_id)));
  if (want.size === 0) return [];
  // 2) что это за объявления: публикация, кампания, аудитория
  const info = new Map<string, any>();
  let ap = await graph<any>(`/${acc}/ads`, {
    limit: "200",
    fields: "id,campaign{name},adset{name,targeting{geo_locations,custom_audiences}},creative{effective_instagram_media_id,instagram_permalink_url,thumbnail_url}",
  });
  for (let i = 0; i < 80; i++) {
    for (const ad of ap.data ?? []) if (want.has(String(ad.id))) info.set(String(ad.id), ad);
    if (info.size >= want.size || !ap.paging?.next) break;
    ap = await graph<any>(ap.paging.next);
  }

  const pubs = new Map<string, Pub>();
  const campSpend = new Map<string, Map<string, number>>(); // группа → название кампании → расход за период (для заголовка)
  for (const r of rows) {
    const sp = Number(r.spend ?? 0);
    const id = String(r.ad_id);
    if (sp <= 0 || !want.has(id)) continue;
    const ad = info.get(id) ?? {};
    const c = ad.creative ?? {};
    const seg = segmentOf(city, ad);
    const key = String(c.effective_instagram_media_id ?? c.instagram_permalink_url ?? id);
    const k = `${seg}|${key}`;
    const p: Pub = pubs.get(k) ?? { seg, key, mediaId: c.effective_instagram_media_id ?? null, thumb: c.thumbnail_url ?? null, ads: new Set(), stats: { spend: 0, impressions: 0, reach: 0, clicks: 0, likes: 0, comments: 0, saves: 0, views: 0 }, first: r.date_start, last: r.date_start };
    p.ads.add(id);
    if (r.date_start >= from && r.date_start <= to) {
      const act: Record<string, number> = {};
      for (const a of r.actions ?? []) act[a.action_type] = Number(a.value ?? 0);
      p.stats.spend += sp;
      p.stats.impressions += Number(r.impressions ?? 0);
      p.stats.reach += Number(r.reach ?? 0);
      p.stats.clicks += Number(r.clicks ?? 0);
      p.stats.likes += act["post_reaction"] ?? 0; // реакции на публикацию (в Instagram это лайки)
      p.stats.comments += act["comment"] ?? 0;
      p.stats.saves += act["onsite_conversion.post_save"] ?? 0;
      p.stats.views += act["video_view"] ?? 0;
      const cn = String(ad.campaign?.name ?? "");
      if (cn && !isPromote(cn)) {
        const m = campSpend.get(seg) ?? new Map<string, number>();
        m.set(cn, (m.get(cn) ?? 0) + sp);
        campSpend.set(seg, m);
      }
    }
    if (r.date_start < p.first) p.first = r.date_start;
    if (r.date_start > p.last) p.last = r.date_start;
    pubs.set(k, p);
  }

  // заголовок группы в Актау — название рабочей кампании, как оно написано в Meta (самая затратная за неделю, кроме созданных кнопкой «Продвигать»)
  const titleOf = (seg: string) => {
    if (city !== "aktau") return FALLBACK_TITLE[seg];
    const m = campSpend.get(seg);
    const best = m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    return best ?? FALLBACK_TITLE[seg];
  };

  const segs = city === "aktau" ? ["aktau", "mang", "similar"] : ["all"];
  const fonts = await loadFonts();
  const covers = new Map<string, Cover>();
  const all = [...pubs.values()];
  for (let i = 0; i < all.length; i += 6) {
    await Promise.all(
      all.slice(i, i + 6).map(async (p) => {
        if (!covers.has(p.key)) covers.set(p.key, await loadCover(p));
      })
    );
  }

  const out: TargetReport[] = [];
  for (const seg of segs) {
    const list = all.filter((p) => p.seg === seg).sort((a, b) => b.stats.spend - a.stats.spend);
    if (list.length === 0) continue;
    const title = titleOf(seg);
    out.push({
      title,
      fileName: `Таргет ${safeName(title)}.pdf`,
      bytes: renderPdf(list, title, from, to, covers, fonts, yesterday),
      publications: list.length,
      spend: list.reduce((x, p) => x + p.stats.spend, 0),
    });
  }
  return out;
}

// Еженедельная отправка: только владельцу (роль «администратор» в боте СММ). Повторный запуск за ту же неделю ничего не шлёт, пока не указан force.
export async function sendWeeklyTargetReports(opts: { city: CityKey; from?: string; to?: string; force?: boolean; dry?: boolean }) {
  const week = opts.from && opts.to ? { from: opts.from, to: opts.to } : lastWeek();
  const admins = (await approvedUsers()).filter((u) => u.role === "admin");
  const kind = `target_week_${opts.city}`;
  const todo = admins.filter(() => true);
  const pending: typeof todo = [];
  for (const u of todo) if (opts.force || !(await wasSent(u.id, kind, week.from))) pending.push(u);
  if (pending.length === 0) return { week, city: opts.city, skipped: "уже отправлено или нет получателя", reports: [] as { title: string; publications: number; spend: number }[] };

  const reports = await buildTargetReports(opts.city, week.from, week.to);
  const summary = reports.map((r) => ({ title: r.title, publications: r.publications, spend: Math.round(r.spend * 100) / 100 }));
  if (opts.dry) return { week, city: opts.city, reports: summary };
  for (const u of pending) {
    for (const r of reports) {
      await sendSmmDocument(u.telegram_chat_id, r.fileName, r.bytes, `🎯 <b>Таргет · ${escapeHtml(r.title)}</b>\n${ruDate(week.from)} — ${ruDate(week.to)} · публикаций ${r.publications} · потрачено ${usd(r.spend)}`);
    }
    // если за неделю расхода не было совсем — всё равно отметим, что неделя проверена, иначе повторы cron будут перестраивать пустой отчёт
    await markSent(u.id, kind, week.from);
  }
  return { week, city: opts.city, reports: summary };
}
