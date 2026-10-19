// Очередной номер сертификата города для подсказок (сайт и бот): самое большое число среди ВСЕХ внесённых в систему сертификатов этого города
// за всё время + 1 (с теми же ведущими нулями и тем же буквенным началом, что у сертификата с самым большим числом). Порядок внесения не важен.
// Ранние сертификаты, которых нет в системе, и старые неиспользованные не показываются. Пока в городе не внесено ни одного сертификата с числом
// в конце номера, подсказки нет (null).
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function nextCertificateNumber(store: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("certificates").select("number").eq("store", store).limit(100000);
  if (error) throw error;
  const rows = (data ?? []) as { number: string }[];
  const taken = new Set(rows.map((r) => String(r.number).trim().toLowerCase()));
  let best: { prefix: string; width: number; n: number } | null = null;
  for (const r of rows) {
    const m = String(r.number).trim().match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const n = Number(m[2]);
    if (!best || n > best.n || (n === best.n && m[2].length > best.width)) best = { prefix: m[1], width: m[2].length, n };
  }
  if (!best) return null;
  let n = best.n;
  for (let i = 0; i < 1000; i++) {
    n += 1;
    const candidate = `${best.prefix}${String(n).padStart(best.width, "0")}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}
