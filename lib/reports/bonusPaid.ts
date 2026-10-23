// Сколько чеков оплачено бонусами: списание бонусов по чеку (1 бонус = 1 ₸) МойСклад пишет отдельной операцией к этому чеку, у нас она лежит в kassa_bonus_tx.
// В самом чеке эта часть записана внутри «безнал», поэтому в отчётах бонусы показываются отдельной строкой и из безнала вычитаются.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function bonusPaidOnDemands(demandIds: string[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < demandIds.length; i += 150) {
    const { data, error } = await supabaseAdmin
      .from("kassa_bonus_tx")
      .select("value")
      .eq("kind", "spend")
      .eq("status", "COMPLETED")
      .eq("parent_type", "retaildemand")
      .in("parent_id", demandIds.slice(i, i + 150));
    if (error) throw error;
    for (const r of (data ?? []) as { value: number }[]) total += Number(r.value) || 0;
  }
  return total;
}
