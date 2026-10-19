// Очередной номер сертификата города для подсказок (сайт и бот): продолжение номера последнего внесённого в систему сертификата этого города
// (+1, с теми же ведущими нулями и тем же буквенным началом). Ранние сертификаты, которых нет в системе, и старые неиспользованные не показываются.
// Пока в городе не внесено ни одного сертификата с числом в конце номера, подсказки нет (null).
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function nextCertificateNumber(store: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("certificates").select("number, sold_at").eq("store", store).order("sold_at", { ascending: false }).limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as { number: string }[];
  const taken = new Set(rows.map((r) => String(r.number).trim().toLowerCase()));
  for (const r of rows) {
    const m = String(r.number).trim().match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const prefix = m[1];
    const width = m[2].length;
    let n = Number(m[2]);
    for (let i = 0; i < 1000; i++) {
      n += 1;
      const candidate = `${prefix}${String(n).padStart(width, "0")}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }
  return null;
}
