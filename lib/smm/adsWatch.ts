// Слежение за таргетом: раз в 10 минут сравниваем активные объявления с прошлой проверкой и сообщаем, какую публикацию запустили
// в таргет и какую выключили (ссылка + обложка). Meta такие события сама не присылает, поэтому сравниваем состояния.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { CITIES, CITY_KEYS, type CityKey } from "@/lib/smm/config";
import { STATUS_TEXT, adStatuses, listTargetPosts, postCover, type TargetPost } from "@/lib/smm/meta";
import { approvedUsers, usersForCity, type SmmUser } from "@/lib/smm/users";
import type { Transport } from "@/lib/smm/telegram";
import { escapeHtml } from "@/lib/telegram";

type StateRow = { city: string; post_key: string; name: string; permalink: string | null; ad_ids: string[]; is_active: boolean; miss: number };

const OFF_AFTER_MISSES = 2; // «выключено» — только если пост не был активен две проверки подряд (не реагируем на сбой Meta)

async function notify(t: Transport, users: SmmUser[], cover: string | null, caption: string) {
  for (const u of users) {
    try {
      if (cover) await t.photo(u.telegram_chat_id, cover, caption);
      else await t.send(u.telegram_chat_id, caption);
    } catch {
      // один недоступный адресат не должен мешать остальным
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

const link = (p: { permalink: string | null }) => (p.permalink ? `\n<a href="${escapeHtml(p.permalink)}">Открыть публикацию</a>` : "");

export type WatchResult = { city: string; active: number; started: number; stopped: number; seeded?: boolean };

export async function watchTarget(t: Transport, opts: { only?: SmmUser[] } = {}): Promise<WatchResult[]> {
  const users = opts.only ?? (await approvedUsers());
  const results: WatchResult[] = [];
  for (const city of CITY_KEYS as CityKey[]) {
    const posts = await listTargetPosts(city); // при сбое Meta бросит ошибку — состояние не трогаем
    const { data, error } = await supabaseAdmin.from("smm_target_posts").select("*").eq("city", city);
    if (error) throw error;
    const state = new Map(((data ?? []) as StateRow[]).map((r) => [r.post_key, r]));
    const now = new Date().toISOString();
    const res: WatchResult = { city, active: posts.length, started: 0, stopped: 0 };
    const recipients = usersForCity(users, city);

    // первый запуск по городу: просто запоминаем, что уже идёт, без сообщений
    if (state.size === 0) {
      for (const p of posts) await upsert(city, p, now, true);
      results.push({ ...res, seeded: true });
      continue;
    }

    const activeKeys = new Set(posts.map((p) => p.key));
    for (const p of posts) {
      const old = state.get(p.key);
      if (!old || !old.is_active) {
        res.started++;
        const cover = await postCover(p);
        await notify(t, recipients, cover, `🟢 <b>Запущено в таргет · ${CITIES[city].title}</b>${p.campaign ? `\nКампания: ${escapeHtml(p.campaign)}` : ""}\nОбъявлений на эту публикацию: ${p.adIds.length}${link(p)}`);
        await upsert(city, p, now, true);
      } else {
        await supabaseAdmin.from("smm_target_posts").update({ ad_ids: p.adIds, name: p.adNames[0] ?? old.name, miss: 0, updated_at: now }).eq("city", city).eq("post_key", p.key);
      }
    }
    for (const old of state.values()) {
      if (!old.is_active || activeKeys.has(old.post_key)) continue;
      const miss = old.miss + 1;
      if (miss < OFF_AFTER_MISSES) {
        await supabaseAdmin.from("smm_target_posts").update({ miss, updated_at: now }).eq("city", city).eq("post_key", old.post_key);
        continue;
      }
      res.stopped++;
      let reason = "";
      try {
        const st = await adStatuses(old.ad_ids.slice(0, 5));
        const first = Object.values(st).find((s) => s && s !== "ACTIVE");
        if (first) reason = `\nПричина: ${STATUS_TEXT[first] ?? first.toLowerCase()}`;
      } catch {
        // причина необязательна
      }
      const cover = await postCover({ mediaId: /^\d+$/.test(old.post_key) ? old.post_key : null, thumb: null });
      await notify(t, recipients, cover, `🔴 <b>Выключено с таргета · ${CITIES[city].title}</b>${reason}${link(old)}`);
      await supabaseAdmin.from("smm_target_posts").update({ is_active: false, miss, ended_at: now, updated_at: now }).eq("city", city).eq("post_key", old.post_key);
    }
    results.push(res);
  }
  return results;
}

async function upsert(city: CityKey, p: TargetPost, now: string, active: boolean) {
  const { error } = await supabaseAdmin.from("smm_target_posts").upsert(
    { city, post_key: p.key, name: p.adNames[0] ?? "", permalink: p.permalink, ad_ids: p.adIds, is_active: active, miss: 0, started_at: now, ended_at: null, updated_at: now },
    { onConflict: "city,post_key" }
  );
  if (error) throw error;
}
