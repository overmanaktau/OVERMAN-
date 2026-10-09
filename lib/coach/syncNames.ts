// Имена сотрудников в боте-помощнике берутся из МойСклад при регистрации. Если человека потом
// переименовали (например, «Нуршат» → «Дузелбаева Нуршат»), в coach_users остаётся старое имя —
// эта функция подтягивает актуальные. Вызывается при открытии страницы «Помощник консультантов»
// и перед утренней рассылкой.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchEmployeeNames } from "@/lib/moysklad";

export async function syncCoachNames(): Promise<{ updated: { from: string; to: string }[] }> {
  const names = await fetchEmployeeNames();
  const { data, error } = await supabaseAdmin.from("coach_users").select("id, employee_ms_id, employee_name").eq("is_test", false);
  if (error) throw error;
  const updated: { from: string; to: string }[] = [];
  for (const u of (data ?? []) as { id: number; employee_ms_id: string; employee_name: string }[]) {
    const fresh = names.get(u.employee_ms_id);
    if (!fresh || fresh === u.employee_name) continue;
    const { error: upErr } = await supabaseAdmin.from("coach_users").update({ employee_name: fresh }).eq("id", u.id);
    if (upErr) throw upErr;
    updated.push({ from: u.employee_name, to: fresh });
  }
  return { updated };
}
